import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
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
 * Auth: single shared Bearer token (AGENT_BEARER_TOKEN). Per-collector
 * tokens are future work.
 */

export interface RemotecfgRouteDeps {
  db: DbPool;
  agentBearerToken: string;
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

    const auth = makeAgentBearerAuth(deps.agentBearerToken);

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

function makeAgentBearerAuth(expected: string) {
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
    if (!token || token !== expected) {
      return reply
        .code(401)
        .header("content-type", "application/json")
        .send({ code: "unauthenticated", message: "invalid bearer token" });
    }
  };
}
