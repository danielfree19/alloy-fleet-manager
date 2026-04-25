import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { DbPool } from "../db/pool.js";
import {
  loadProtoMessages,
  type GetConfigRequest,
  type GetConfigResponse,
  type RegisterCollectorRequest,
  type RegisterCollectorResponse,
  type UnregisterCollectorRequest,
  type UnregisterCollectorResponse,
} from "./proto.js";
import { makeUnaryHandler } from "./connect.js";
import { buildHandlers } from "./handlers.js";
import { makeResolveActor } from "../auth/middleware.js";
import { actorHasPermission } from "../auth/permissions.js";

/**
 * Mounts the Connect RPC endpoints that Alloy's `remotecfg` block calls:
 *
 *   POST /collector.v1.CollectorService/GetConfig
 *   POST /collector.v1.CollectorService/RegisterCollector
 *   POST /collector.v1.CollectorService/UnregisterCollector
 *
 * Alloy sends `Content-Type: application/proto` by default (connect-go
 * default). We also accept `application/json` so operators can curl/debug.
 *
 * Auth (two accepted Bearer formats — tried in order):
 *
 *   1. The legacy shared `AGENT_BEARER_TOKEN` env var. Kept for back-
 *      compat with existing fleets and for the simplest deployments.
 *      Constant-time compared.
 *
 *   2. Any `fmt_…` API token (or the env `ADMIN_TOKEN`) whose actor
 *      carries the `collectors.poll` permission. The built-in `agent`
 *      role grants only that permission, so the recommended setup is
 *      "issue one `agent`-role token per Alloy instance from the UI".
 *
 * Either path is sufficient. Failing both → 401.
 */

export interface RemotecfgRouteDeps {
  db: DbPool;
  /** Legacy shared bearer (AGENT_BEARER_TOKEN). Kept for back-compat. */
  agentBearerToken: string;
  /** Env break-glass token (ADMIN_TOKEN). Forwarded to resolveActor. */
  adminToken: string;
}

export function registerRemotecfgRoutes(deps: RemotecfgRouteDeps): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    // Register a binary body parser for application/proto so req.body is a Buffer.
    app.addContentTypeParser(
      ["application/proto", "application/x-protobuf"],
      { parseAs: "buffer" },
      (_req, body, done) => {
        done(null, body);
      },
    );

    const proto = loadProtoMessages();
    const handlers = buildHandlers({ db: deps.db });

    const auth = makeRemotecfgAuth({
      db: deps.db,
      legacyAgentToken: deps.agentBearerToken,
      adminToken: deps.adminToken,
    });

    const getConfig = makeUnaryHandler<GetConfigRequest, GetConfigResponse>({
      reqType: proto.GetConfigRequest,
      resType: proto.GetConfigResponse,
      handle: (req, ctx) => handlers.getConfig(req, { log: ctx.fastifyReq.log }),
    });
    const registerCollector = makeUnaryHandler<
      RegisterCollectorRequest,
      RegisterCollectorResponse
    >({
      reqType: proto.RegisterCollectorRequest,
      resType: proto.RegisterCollectorResponse,
      handle: (req, ctx) =>
        handlers.registerCollector(req, { log: ctx.fastifyReq.log }),
    });
    const unregisterCollector = makeUnaryHandler<
      UnregisterCollectorRequest,
      UnregisterCollectorResponse
    >({
      reqType: proto.UnregisterCollectorRequest,
      resType: proto.UnregisterCollectorResponse,
      handle: (req) => handlers.unregisterCollector(req),
    });

    app.post(
      "/collector.v1.CollectorService/GetConfig",
      { preHandler: auth },
      getConfig,
    );
    app.post(
      "/collector.v1.CollectorService/RegisterCollector",
      { preHandler: auth },
      registerCollector,
    );
    app.post(
      "/collector.v1.CollectorService/UnregisterCollector",
      { preHandler: auth },
      unregisterCollector,
    );
  };
}

/**
 * Two-stage auth for the remotecfg RPC surface.
 *
 *   1. Legacy fast-path: timing-safe compare against AGENT_BEARER_TOKEN.
 *      This costs zero DB queries and is what every existing deployment
 *      uses — keeping it first means upgrading the manager doesn't make
 *      polls 1ms slower.
 *
 *   2. Identity-system path: route the bearer through the same
 *      `resolveActor` middleware that the admin API uses, then check
 *      for `collectors.poll`. This unlocks per-Alloy `fmt_…` tokens
 *      with the built-in `agent` role.
 *
 * On success of path (2) we set `req.actor` so handlers/loggers can
 * see who polled. We deliberately do NOT touch the audit log on every
 * poll (Alloy polls every ~30s; that would dwarf the rest of the
 * audit feed). `api_tokens.last_used_at` is already bumped by
 * `verifyApiToken`, which gives operators a "is this collector still
 * alive?" signal without flooding `audit_events`.
 */
function makeRemotecfgAuth(deps: {
  db: DbPool;
  legacyAgentToken: string;
  adminToken: string;
}) {
  const resolveActor = makeResolveActor({
    db: deps.db,
    adminToken: deps.adminToken,
  });

  return async function (req: FastifyRequest, reply: FastifyReply) {
    const h = req.headers["authorization"];
    if (typeof h !== "string") {
      return reply
        .code(401)
        .header("content-type", "application/json")
        .send({ code: "unauthenticated", message: "missing Authorization header" });
    }
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    const token = m && m[1] ? m[1] : null;
    if (!token) {
      return reply
        .code(401)
        .header("content-type", "application/json")
        .send({ code: "unauthenticated", message: "invalid bearer token" });
    }

    // Path 1: legacy shared AGENT_BEARER_TOKEN, constant-time.
    if (timingSafeBearerEqual(token, deps.legacyAgentToken)) {
      return;
    }

    // Path 2: identity-system actor with `collectors.poll`.
    const actor = await resolveActor(req);
    if (actor && actorHasPermission(actor, "collectors.poll")) {
      req.actor = actor;
      return;
    }

    return reply
      .code(401)
      .header("content-type", "application/json")
      .send({
        code: "unauthenticated",
        message: "invalid bearer token or insufficient permission (need collectors.poll)",
      });
  };
}

function timingSafeBearerEqual(a: string, b: string): boolean {
  // Reject early on length mismatch — timingSafeEqual throws when
  // lengths differ. The length leak is fine here because token
  // format (and therefore length) is public.
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}
