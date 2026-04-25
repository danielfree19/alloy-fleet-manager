import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import protobuf from "protobufjs";

/**
 * Loads the vendored collector.v1 proto at runtime via protobufjs. We avoid
 * any code generation step so the build is "just TypeScript". Runtime cost is
 * a one-time ~5ms parse on startup.
 */

// Plain-object shapes we expose to the rest of the code. They intentionally
// mirror the proto but in TypeScript-native form (maps as plain objects).

export type RemoteConfigStatusName =
  | "RemoteConfigStatuses_UNSET"
  | "RemoteConfigStatuses_APPLIED"
  | "RemoteConfigStatuses_APPLYING"
  | "RemoteConfigStatuses_FAILED";

export interface RemoteConfigStatus {
  status?: RemoteConfigStatusName | number;
  error_message?: string;
}

export interface GetConfigRequest {
  id: string;
  // Field 2 (deprecated in the proto, but current Alloy releases still send
  // the `remotecfg { attributes = {...} }` config block here).
  attributes?: Record<string, string>;
  // Field 4 (newer). Preferred when present.
  local_attributes?: Record<string, string>;
  hash?: string;
  remote_config_status?: RemoteConfigStatus;
  // `effective_config` is accepted but ignored server-side.
}

export interface GetConfigResponse {
  content: string;
  hash: string;
  not_modified: boolean;
}

export interface RegisterCollectorRequest {
  id: string;
  // Same story as GetConfigRequest: support both the deprecated and new fields.
  attributes?: Record<string, string>;
  local_attributes?: Record<string, string>;
  name?: string;
}

export type RegisterCollectorResponse = Record<string, never>;

export interface UnregisterCollectorRequest {
  id: string;
}

export type UnregisterCollectorResponse = Record<string, never>;

// Messages we actually serialize/deserialize server-side.
const MESSAGE_NAMES = [
  "collector.v1.GetConfigRequest",
  "collector.v1.GetConfigResponse",
  "collector.v1.RegisterCollectorRequest",
  "collector.v1.RegisterCollectorResponse",
  "collector.v1.UnregisterCollectorRequest",
  "collector.v1.UnregisterCollectorResponse",
] as const;

export type MessageName = (typeof MESSAGE_NAMES)[number];

export interface ProtoMessages {
  GetConfigRequest: protobuf.Type;
  GetConfigResponse: protobuf.Type;
  RegisterCollectorRequest: protobuf.Type;
  RegisterCollectorResponse: protobuf.Type;
  UnregisterCollectorRequest: protobuf.Type;
  UnregisterCollectorResponse: protobuf.Type;
}

let cached: ProtoMessages | null = null;

export function loadProtoMessages(): ProtoMessages {
  if (cached) return cached;

  // Resolve the vendored proto relative to the repo root. We walk up from
  // this file: apps/fleet-manager/src/remotecfg/proto.ts -> repo root is 4
  // levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const protoPath = resolve(here, "../../../../proto/collector/v1/collector.proto");

  // IMPORTANT: `keepCase: true` preserves snake_case proto field names in the
  // JS object produced by `toObject`. Without this, protobufjs rewrites
  // `local_attributes` -> `localAttributes`, `remote_config_status` ->
  // `remoteConfigStatus`, etc., and our handlers (which read the snake_case
  // fields defined in the .proto) silently see `undefined`.
  const root = new protobuf.Root();
  root.loadSync(protoPath, { keepCase: true });

  const lookup = (n: string): protobuf.Type => {
    const t = root.lookupType(n);
    if (!t) throw new Error(`proto type not found: ${n}`);
    return t;
  };

  cached = {
    GetConfigRequest: lookup("collector.v1.GetConfigRequest"),
    GetConfigResponse: lookup("collector.v1.GetConfigResponse"),
    RegisterCollectorRequest: lookup("collector.v1.RegisterCollectorRequest"),
    RegisterCollectorResponse: lookup("collector.v1.RegisterCollectorResponse"),
    UnregisterCollectorRequest: lookup("collector.v1.UnregisterCollectorRequest"),
    UnregisterCollectorResponse: lookup("collector.v1.UnregisterCollectorResponse"),
  };
  return cached;
}

// protobufjs's IConversionOptions expects Function constructors (String, Number,
// ...) for its `longs`/`enums`/`bytes` options. String => base64-encoded bytes
// in the output object, which is what the Connect JSON codec wants.
const DECODE_OPTS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
  defaults: true,
  oneofs: true,
};
const JSON_OPTS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
  json: true,
};

/** Decode a protobuf binary message to a plain object, applying defaults. */
export function decodeProto<T>(type: protobuf.Type, buf: Uint8Array): T {
  const msg = type.decode(buf);
  return type.toObject(msg, DECODE_OPTS) as T;
}

/** Encode a plain object to protobuf binary, verifying first. */
export function encodeProto<T extends object>(type: protobuf.Type, obj: T): Uint8Array {
  const err = type.verify(obj);
  if (err) throw new Error(`proto verify failed for ${type.name}: ${err}`);
  const msg = type.create(obj);
  return type.encode(msg).finish();
}

/** Decode from the Connect JSON codec. protobufjs accepts plain objects directly. */
export function decodeJson<T>(type: protobuf.Type, raw: unknown): T {
  const verified = type.fromObject((raw ?? {}) as object);
  return type.toObject(verified, DECODE_OPTS) as T;
}

/** Encode to a JSON-serializable plain object (Connect JSON codec). */
export function encodeJson<T extends object>(type: protobuf.Type, obj: T): object {
  const err = type.verify(obj);
  if (err) throw new Error(`proto verify failed for ${type.name}: ${err}`);
  const msg = type.create(obj);
  return type.toObject(msg, JSON_OPTS);
}
