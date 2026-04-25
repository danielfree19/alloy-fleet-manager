/**
 * Auth routes — login, logout, me, change-own-password.
 *
 * Sessions are stored server-side (see auth/sessions.ts); the browser
 * only ever holds an opaque cookie. The /auth/me endpoint is the
 * single source of truth for "who am I and what can I do?" — the UI
 * polls it after a successful login and uses the returned permissions
 * to gate menu items.
 *
 * Brute-force protection has TWO layers, both engaged on /auth/login:
 *
 *   1. Per-IP rate limit registered in server.ts via @fastify/rate-limit
 *      (10 attempts / 15 min). Defeats credential-stuffing throughput.
 *   2. Per-account lockout — 5 consecutive bad passwords lock the row
 *      for 15 minutes (auth/users.ts: recordLoginFailure). Defeats a
 *      slow stuffer who paces below the IP rate limit.
 *
 * bcrypt cost factor 12 (~250ms) is the third layer and runs even on
 * locked accounts so the response time can't be used to fingerprint
 * lock state.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeRequireAuthenticated } from "../auth/middleware.js";
import { verifyPassword } from "../auth/passwords.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  deleteSession,
} from "../auth/sessions.js";
import {
  clearLoginFailures,
  findUserByEmail,
  findUserById,
  isAccountLocked,
  listUserRoles,
  loadUserPermissions,
  recordLoginFailure,
  setPassword,
} from "../auth/users.js";
import { auditFieldsFromActor, recordAuditEvent } from "../services/audit.js";
import type { Actor } from "../auth/permissions.js";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

export function registerAuthRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const requireAuthenticated = makeRequireAuthenticated({
      db,
      adminToken: config.ADMIN_TOKEN,
    });

    /**
     * Sign in with email + password. On success creates a session row
     * and sets the `fleet.sid` cookie. The token-paste flow remains
     * available for break-glass via ADMIN_TOKEN as a Bearer header.
     */
    app.post(
      "/auth/login",
      {
        // Per-IP cap defeats credential stuffing throughput. The
        // window is short enough that a real user who fat-fingered
        // their password gets retries within a coffee break, but
        // narrow enough that a stuffer hits a wall fast.
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "15 minutes",
          },
        },
      },
      async (req, reply) => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { email, password } = parsed.data;

      // Same error message and roughly the same timing whether the
      // user exists or not. A real attacker can still time-distinguish
      // because of the bcrypt vs no-bcrypt branch, but nothing about
      // our threat model justifies the complexity of a fake-hash
      // dummy compare.
      const user = await findUserByEmail(db, email);
      if (!user || !user.password_hash || user.disabled) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      // ALWAYS run bcrypt — even for a locked account. The response
      // time of "wrong password while locked" must match "wrong
      // password while unlocked" so an attacker can't probe lock
      // state for free. We branch on the result + lock state below.
      const passwordOk = await verifyPassword(password, user.password_hash);
      const locked = isAccountLocked(user);

      if (locked) {
        // Audit the locked-attempt before responding. Doing it here
        // means a real auditor sees one row per "blocked credential
        // stuffer probe", not just the original lock event.
        await recordAuditEvent(db, {
          actor: `user:${user.email}`,
          actor_kind: null,
          actor_user_id: user.id,
          actor_email: user.email,
          actor_token_id: null,
          action: "auth.login.locked",
          target_kind: "user",
          target_id: user.id,
          target_name: user.email,
          metadata: {
            locked_until: user.locked_until,
            ip: req.ip,
            password_was_correct: passwordOk,
          },
        });
        return reply.code(423).send({
          error: "account_locked",
          locked_until: user.locked_until,
        });
      }

      if (!passwordOk) {
        const result = await recordLoginFailure(db, user.id);
        if (result.locked) {
          // We just tipped them over the threshold — emit the
          // canonical lock-event row so audit dashboards can show
          // "this is the attempt that locked the account".
          await recordAuditEvent(db, {
            actor: `user:${user.email}`,
            actor_kind: null,
            actor_user_id: user.id,
            actor_email: user.email,
            actor_token_id: null,
            action: "auth.login.locked",
            target_kind: "user",
            target_id: user.id,
            target_name: user.email,
            metadata: {
              locked_until: result.locked_until,
              ip: req.ip,
              failures: result.failures,
              password_was_correct: false,
            },
          });
        }
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      // Password was right and the account isn't locked — clear any
      // accumulated failure state and fall through to session creation.
      await clearLoginFailures(db, user.id);

      const session = await createSession(db, user.id, {
        user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        ip: req.ip,
      });

      reply.setCookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.protocol === "https",
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        signed: true,
      });

      const perms = await loadUserPermissions(db, user.id);
      const roles = await listUserRoles(db, user.id);

      // Audit the successful sign-in. The actor is the user themselves —
      // there is no preHandler on /auth/login (the whole point of login
      // is to be unauthenticated), so we synthesize a user Actor inline.
      const loginActor: Actor = {
        kind: "user",
        userId: user.id,
        email: user.email,
        name: user.name,
        apiTokenId: null,
        permissions: perms,
      };
      await recordAuditEvent(db, {
        ...auditFieldsFromActor(loginActor),
        action: "auth.login",
        target_kind: "user",
        target_id: user.id,
        target_name: user.email,
        metadata: {
          session_id: session.id,
          ip: req.ip,
          user_agent:
            typeof req.headers["user-agent"] === "string"
              ? req.headers["user-agent"]
              : null,
        },
      });

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          disabled: user.disabled,
        },
        roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
        permissions: Array.from(perms),
      };
    });

    /**
     * Sign out: clear the cookie and delete the session row. Idempotent.
     * Always returns 204 even if no session was set, so the UI doesn't
     * have to special-case the "I was already signed out" path.
     */
    app.post("/auth/logout", async (req, reply) => {
      // We read the cookie via @fastify/cookie's built-in unsignCookie
      // because the cookie was set with `signed: true`. If signature
      // is invalid we treat that as "no session" — it's a logout, we
      // shouldn't 401.
      const raw = req.cookies?.[SESSION_COOKIE];
      if (raw) {
        const unsigned = req.unsignCookie(raw);
        if (unsigned.valid && unsigned.value) {
          // Look up the session BEFORE deleting so we can attribute the
          // logout event to the right user. Best-effort: a missing row
          // (already-expired or already-logged-out) just skips the audit.
          const lookup = await db.query<{ user_id: string }>(
            `SELECT user_id FROM sessions WHERE id = $1`,
            [unsigned.value],
          );
          const userId = lookup.rows[0]?.user_id ?? null;
          await deleteSession(db, unsigned.value);

          if (userId) {
            const user = await findUserById(db, userId);
            if (user) {
              const perms = await loadUserPermissions(db, user.id);
              const logoutActor: Actor = {
                kind: "user",
                userId: user.id,
                email: user.email,
                name: user.name,
                apiTokenId: null,
                permissions: perms,
              };
              await recordAuditEvent(db, {
                ...auditFieldsFromActor(logoutActor),
                action: "auth.logout",
                target_kind: "user",
                target_id: user.id,
                target_name: user.email,
                metadata: { session_id: unsigned.value },
              });
            }
          }
        }
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    /**
     * Whoami: the UI's source of truth for the current actor. Returns
     * the same shape as /auth/login, but works for ANY authenticated
     * actor — including a Bearer ADMIN_TOKEN or API token, in which
     * case the UI shows "(env token)" / the token name in place of
     * the email.
     *
     * `actor.oidc_provider` is populated for users whose identity is
     * bound to a configured IdP — the UI uses this to render the
     * "SSO · <provider>" badge on rows in the Users page and to gate
     * the "Change password" form on My Account (SSO users have no
     * local password to change).
     */
    app.get(
      "/auth/me",
      { preHandler: requireAuthenticated },
      async (req) => {
        const actor = req.actor!;
        // Cheap lookup; only runs for user-kind actors and returns
        // the (issuer, subject) so the UI can disambiguate which
        // provider this user is bound to.
        let oidcIssuer: string | null = null;
        let oidcSubject: string | null = null;
        if (actor.kind === "user" && actor.userId) {
          const u = await findUserById(db, actor.userId);
          oidcIssuer = u?.oidc_issuer ?? null;
          oidcSubject = u?.oidc_subject ?? null;
        }
        return {
          actor: {
            kind: actor.kind,
            user_id: actor.userId,
            email: actor.email,
            name: actor.name,
            api_token_id: actor.apiTokenId,
            // Pure addition; existing UI code that reads the old
            // shape continues to work unchanged.
            oidc_issuer: oidcIssuer,
            oidc_subject: oidcSubject,
          },
          permissions: Array.from(actor.permissions),
        };
      },
    );

    /**
     * Self-service password change. Every authenticated USER (not
     * env-token, not api-token) can call this. We require the current
     * password to prevent a stolen session cookie from being used to
     * permanently lock the real user out.
     */
    app.post(
      "/auth/password",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        if (actor.kind !== "user" || !actor.userId) {
          return reply
            .code(400)
            .send({ error: "self_service_only", details: "API tokens and the env token cannot change passwords." });
        }
        const parsed = ChangePasswordBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const { current_password, new_password } = parsed.data;

        const user = await findUserById(db, actor.userId);
        if (!user || !user.password_hash) {
          return reply.code(400).send({ error: "no_local_password" });
        }
        const ok = await verifyPassword(current_password, user.password_hash);
        if (!ok) {
          return reply.code(401).send({ error: "invalid_credentials" });
        }
        await setPassword(db, user.id, new_password);

        // Audit the password change. We DELIBERATELY do not include the
        // new (or old) password in metadata — the row should be safe to
        // share with auditors. The actor IS the user, so we record both
        // sides identically.
        await recordAuditEvent(db, {
          ...auditFieldsFromActor(actor),
          action: "auth.password.change",
          target_kind: "user",
          target_id: user.id,
          target_name: user.email,
          metadata: {},
        });

        return reply.code(204).send();
      },
    );
  };
}
