import type { FastifyReply, FastifyRequest } from "fastify";
import type protobuf from "protobufjs";
import {
  decodeProto,
  encodeProto,
  decodeJson,
  encodeJson,
} from "./proto.js";

/**
 * Minimal Connect unary protocol implementation for server-side.
 * Spec: https://connectrpc.com/docs/protocol/#unary-request
 *
 * We support two codecs, both POST only:
 *   - application/proto  (connect-go default; what Alloy sends)
 *   - application/json   (useful for curl/manual testing)
 *
 * We do NOT implement the streaming envelope codecs
 * (application/connect+proto, application/connect+json) because
 * CollectorService has no streaming RPCs.
 */

export type Codec = "proto" | "json";

export interface ConnectError {
  code:
    | "invalid_argument"
    | "not_found"
    | "unauthenticated"
    | "permission_denied"
    | "internal"
    | "unimplemented";
  message: string;
}

export class RpcError extends Error {
  constructor(
    public readonly code: ConnectError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const CODE_TO_HTTP: Record<ConnectError["code"], number> = {
  invalid_argument: 400,
  not_found: 404,
  unauthenticated: 401,
  permission_denied: 403,
  internal: 500,
  unimplemented: 501,
};

export function detectCodec(contentType: string | undefined): Codec | null {
  if (!contentType) return null;
  const ct = contentType.split(";")[0]?.trim().toLowerCase();
  if (ct === "application/proto" || ct === "application/x-protobuf") return "proto";
  if (ct === "application/json") return "json";
  // Connect's unary also allows the short forms above; streaming envelopes
  // ("application/connect+proto") are explicitly NOT supported here.
  return null;
}

export interface UnaryDeps<Req, Res> {
  reqType: protobuf.Type;
  resType: protobuf.Type;
  handle: (req: Req, ctx: { fastifyReq: FastifyRequest }) => Promise<Res>;
}

/**
 * Build a Fastify route handler for one unary Connect RPC. The route path
 * you register MUST be `/<package>.<service>/<method>` to match the Connect
 * URL scheme.
 */
export function makeUnaryHandler<Req, Res extends object>(
  deps: UnaryDeps<Req, Res>,
) {
  return async function handler(req: FastifyRequest, reply: FastifyReply) {
    if (req.method !== "POST") {
      return sendError(reply, "json", {
        code: "invalid_argument",
        message: "Connect unary RPCs require POST",
      });
    }

    const codec = detectCodec(req.headers["content-type"] as string | undefined);
    if (!codec) {
      return sendError(reply, "json", {
        code: "invalid_argument",
        message:
          "Unsupported Content-Type. Use application/proto or application/json.",
      });
    }

    // Decode.
    let decoded: Req;
    try {
      if (codec === "proto") {
        const raw = req.body as Buffer | Uint8Array | null;
        if (!raw || !(raw instanceof Uint8Array || Buffer.isBuffer(raw))) {
          return sendError(reply, codec, {
            code: "invalid_argument",
            message: "missing protobuf body",
          });
        }
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        req.log.debug(
          { codec, bodyLen: bytes.byteLength },
          "remotecfg request body",
        );
        decoded = decodeProto<Req>(deps.reqType, bytes);
      } else {
        const raw = req.body ?? {};
        req.log.debug({ codec }, "remotecfg request body");
        decoded = decodeJson<Req>(deps.reqType, raw as object);
      }
    } catch (err) {
      return sendError(reply, codec, {
        code: "invalid_argument",
        message: `failed to decode request: ${(err as Error).message}`,
      });
    }

    // Dispatch.
    let result: Res;
    try {
      result = await deps.handle(decoded, { fastifyReq: req });
    } catch (err) {
      if (err instanceof RpcError) {
        return sendError(reply, codec, { code: err.code, message: err.message });
      }
      req.log.error({ err: (err as Error).message }, "unary handler threw");
      return sendError(reply, codec, {
        code: "internal",
        message: (err as Error).message,
      });
    }

    // Encode + send.
    try {
      if (codec === "proto") {
        const bytes = encodeProto(deps.resType, result);
        reply
          .code(200)
          .header("content-type", "application/proto")
          .header("connect-protocol-version", "1")
          .send(Buffer.from(bytes));
      } else {
        const json = encodeJson(deps.resType, result);
        reply
          .code(200)
          .header("content-type", "application/json")
          .header("connect-protocol-version", "1")
          .send(json);
      }
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "failed to encode response");
      return sendError(reply, codec, {
        code: "internal",
        message: "failed to encode response",
      });
    }
  };
}

function sendError(reply: FastifyReply, codec: Codec, err: ConnectError) {
  const http = CODE_TO_HTTP[err.code];
  if (codec === "json") {
    return reply
      .code(http)
      .header("content-type", "application/json")
      .header("connect-protocol-version", "1")
      .send(err);
  }
  // Per spec, proto codec errors are returned as JSON regardless.
  return reply
    .code(http)
    .header("content-type", "application/json")
    .header("connect-protocol-version", "1")
    .send(err);
}
