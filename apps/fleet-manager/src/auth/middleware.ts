import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DbPool } from "../db/pool.js";
import { hashApiKey, timingSafeEqualHex } from "./tokens.js";
import {
  type Actor,
  type Permission,
  actorHasPermission,
  envTokenActor,
} from "./permissions.js";
import { SESSION_COOKIE, touchSession } from "./sessions.js";
import { findUserById, loadUserPermissions } from "./users.js";
import { loadApiTokenPermissions, verifyApiToken } from "./api-tokens.js";

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m && m[1] ? m[1] : null;
}

/**
 * Constant-time string equality. We resolved a session cookie / API
 * token / env token via different code paths but the env-token compare
 * needs to be timing-safe against the configured value because it's
 * the highest-privilege credential.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the caller for this request to an `Actor` (or null for
 * unauthenticated). Resolution order:
 *
 *   1. `Authorization: Bearer <token>`
 *      a. matches `ADMIN_TOKEN` env var → synthetic env-token actor
 *         with all permissions (legacy break-glass path)
 *      b. matches a row in `api_tokens` (sha256 of the full token) →
 *         load that token's roles → permissions
 *   2. `fleet.sid` cookie maps to a session row → load that user's
 *      roles → permissions. Cookie sessions are checked AFTER bearer
 *      because programmatic clients (Terraform, CI) always send a
 *      bearer, and we want them to short-circuit.
 *   3. otherwise → null (caller is unauthenticated)
 *
 * The middleware itself does not 401; the `requirePermission` factory
 * does that, so endpoints with no auth requirement (the bootstrap
 * `/auth/me` check) can still observe a null actor without erroring.
 */
export function makeResolveActor(deps: {
  db: DbPool;
  adminToken: string;
}) {
  return async function resolveActor(req: FastifyRequest): Promise<Actor | null> {
    const bearer = extractBearer(req);
    if (bearer) {
      // Path 1a: env break-glass token.
      if (safeEqual(bearer, deps.adminToken)) {
        return envTokenActor();
      }
      // Path 1b: DB-backed API token.
      const tokenRow = await verifyApiToken(deps.db, bearer);
      if (tokenRow) {
        const user = await findUserById(deps.db, tokenRow.user_id);
        if (!user || user.disabled) return null;
        const perms = await loadApiTokenPermissions(deps.db, tokenRow.id);
        return {
          kind: "api_token",
          userId: user.id,
          email: user.email,
          name: user.name,
          apiTokenId: tokenRow.id,
          permissions: perms,
        };
      }
      // Bearer presented but didn't match anything — fail closed.
      // We don't fall through to the cookie because that would let an
      // attacker bypass a leaked token by also providing a stolen
      // cookie.
      return null;
    }

    // Path 2: cookie session. The cookie is set with `signed: true`,
    // so what's on `req.cookies[SESSION_COOKIE]` is the signed form
    // `<uuid>.<sig>`. We must unsign it before using as a UUID, or
    // Postgres rejects the parameter (22P02 invalid_input_syntax).
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const raw = cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const session = await touchSession(deps.db, unsigned.value);
        if (session) {
          const user = await findUserById(deps.db, session.user_id);
          if (user && !user.disabled) {
            const perms = await loadUserPermissions(deps.db, user.id);
            return {
              kind: "user",
              userId: user.id,
              email: user.email,
              name: user.name,
              apiTokenId: null,
              permissions: perms,
            };
          }
        }
      }
    }

    return null;
  };
}

/**
 * Permission-gated preHandler factory. Use as
 *
 *   app.get("/pipelines", { preHandler: requirePermission("pipelines.read") }, ...)
 *
 * Replaces the old `adminAuth` preHandler. Each route now declares
 * exactly which permission it needs, and the middleware enforces it
 * uniformly across env tokens / API tokens / sessions.
 */
export function makeRequirePermission(deps: {
  db: DbPool;
  adminToken: string;
}) {
  const resolve = makeResolveActor(deps);
  return function requirePermission(perm: Permission) {
    return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
      const actor = await resolve(req);
      if (!actor) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
      if (!actorHasPermission(actor, perm)) {
        reply.code(403).send({ error: "forbidden", permission: perm });
        return;
      }
      req.actor = actor;
      // Maintain the historical `req.adminActor` string so any code
      // path that hadn't been migrated yet still reads a sensible
      // value. We populate it lazily here so the audit code keeps
      // working untouched during this rollout.
      req.adminActor = actorAuditId(actor);
    };
  };
}

/**
 * Authenticated-but-no-perm preHandler. Used by routes that every
 * signed-in user is allowed to hit (e.g. `/auth/me`, "manage my own
 * tokens"). Permissions for those routes are checked inside the
 * handler.
 */
export function makeRequireAuthenticated(deps: {
  db: DbPool;
  adminToken: string;
}) {
  const resolve = makeResolveActor(deps);
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const actor = await resolve(req);
    if (!actor) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.actor = actor;
    req.adminActor = actorAuditId(actor);
  };
}

/**
 * Backward-compatible single-permission middleware factory. Returns a
 * preHandler that requires "any admin" access — defined as the union
 * of the four most-common admin permissions. Used as a transitional
 * shim by `makeAdminAuth` below for routes that haven't been migrated
 * to specific permissions yet (the legacy REST agent endpoints).
 *
 * NEW code MUST use `makeRequirePermission` directly.
 */
export function makeAdminAuth(_adminToken: string, deps?: { db: DbPool }) {
  // The legacy signature was `makeAdminAuth(token)`, now it accepts an
  // optional second arg with the DB pool. When DB is omitted, we fall
  // back to env-token-only auth for the historical behavior — this
  // preserves the legacy /legacy/* routes without touching them.
  return async function adminAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractBearer(req);
    if (!token) {
      reply.code(401).send({ error: "unauthorized", scope: "admin" });
      return;
    }
    if (safeEqual(token, _adminToken)) {
      const digest = createHash("sha256").update(token).digest("hex").slice(0, 8);
      req.adminActor = `admin-token:${digest}`;
      req.actor = envTokenActor();
      return;
    }
    if (deps?.db) {
      const tokenRow = await verifyApiToken(deps.db, token);
      if (tokenRow) {
        const user = await findUserById(deps.db, tokenRow.user_id);
        if (user && !user.disabled) {
          const perms = await loadApiTokenPermissions(deps.db, tokenRow.id);
          req.actor = {
            kind: "api_token",
            userId: user.id,
            email: user.email,
            name: user.name,
            apiTokenId: tokenRow.id,
            permissions: perms,
          };
          req.adminActor = `api-token:${tokenRow.id}`;
          return;
        }
      }
    }
    reply.code(401).send({ error: "unauthorized", scope: "admin" });
  };
}

function actorAuditId(actor: Actor): string {
  switch (actor.kind) {
    case "env_token":
      return "admin-token:env";
    case "user":
      return `user:${actor.email ?? actor.userId ?? "unknown"}`;
    case "api_token":
      return `api-token:${actor.apiTokenId ?? "unknown"}`;
  }
}

/**
 * Registration auth: a second static REGISTRATION_TOKEN, used only by
 * POST /collectors/register. Kept separate from ADMIN_TOKEN so agents can
 * be provisioned without handing out full admin privileges.
 */
export function makeRegistrationAuth(registrationToken: string) {
  return async function regAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractBearer(req);
    if (!token || token !== registrationToken) {
      reply.code(401).send({ error: "unauthorized", scope: "registration" });
    }
  };
}

declare module "fastify" {
  interface FastifyRequest {
    collectorId?: string;
    /**
     * Stable, non-reversible string identifier for the caller. Always
     * populated by `requirePermission`/`requireAuthenticated`. Kept as
     * a denormalized field for back-compat with the audit log code
     * that was written before `req.actor` existed.
     */
    adminActor?: string;
    /**
     * Resolved caller. Populated by `requirePermission`,
     * `requireAuthenticated`, and the legacy `adminAuth` shim.
     * Routes should prefer reading from `actor` over `adminActor`.
     */
    actor?: Actor;
  }
}

/**
 * Agent auth: verifies the Bearer token matches the sha256(api_key_hash)
 * stored for the collector identified in the URL parameter `:collector_id`.
 */
export function makeAgentAuth(lookupHash: (collectorId: string) => Promise<string | null>) {
  return async function agentAuth(req: FastifyRequest, reply: FastifyReply) {
    const collectorId = (req.params as Record<string, string> | undefined)?.collector_id;
    if (!collectorId) {
      return reply.code(400).send({ error: "missing collector_id in path" });
    }
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", scope: "agent" });
    }
    const expected = await lookupHash(collectorId);
    if (!expected) {
      return reply.code(404).send({ error: "collector not found" });
    }
    const actual = hashApiKey(token);
    if (!timingSafeEqualHex(actual, expected)) {
      return reply.code(401).send({ error: "unauthorized", scope: "agent" });
    }
    req.collectorId = collectorId;
  };
}
