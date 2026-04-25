import type { FastifyBaseLogger } from "fastify";
import type { DbPool } from "../db/pool.js";
import { assembleConfigFor } from "../services/pipeline-assembler.js";
import { RpcError } from "./connect.js";
import type {
  GetConfigRequest,
  GetConfigResponse,
  RegisterCollectorRequest,
  RegisterCollectorResponse,
  UnregisterCollectorRequest,
  UnregisterCollectorResponse,
} from "./proto.js";

interface HandlerCtx {
  log?: FastifyBaseLogger;
}

/**
 * Business logic for the three CollectorService RPCs.
 *
 * GetConfig is the only RPC Alloy itself calls in steady state. Register /
 * Unregister are convenience RPCs; we accept them to match the upstream
 * surface but they're optional from Alloy's POV.
 */

export interface HandlerDeps {
  db: DbPool;
}

export function buildHandlers({ db }: HandlerDeps) {
  return {
    async getConfig(
      req: GetConfigRequest,
      ctx?: HandlerCtx,
    ): Promise<GetConfigResponse> {
      if (!req.id || req.id.trim().length === 0) {
        throw new RpcError("invalid_argument", "id is required");
      }
      // Alloy's `remotecfg { attributes = {...} }` block populates the
      // deprecated proto field `attributes` (field 2). Newer clients use
      // `local_attributes` (field 4). Merge with local_attributes taking
      // precedence so we're forward- and backward-compatible.
      const attrs: Record<string, string> = {
        ...(req.attributes ?? {}),
        ...(req.local_attributes ?? {}),
      };

      ctx?.log?.debug(
        {
          remotecfg: {
            id: req.id,
            hash: req.hash,
            attributes: attrs,
            status: req.remote_config_status?.status,
          },
        },
        "GetConfig",
      );

      // Upsert the collector row with the attrs we just received. Keeps the
      // inventory fresh even if the client never calls RegisterCollector.
      const status =
        typeof req.remote_config_status?.status === "string"
          ? mapStatusName(req.remote_config_status.status)
          : null;
      const errorMsg = req.remote_config_status?.error_message ?? null;

      await db.query(
        `
        INSERT INTO remotecfg_collectors (id, local_attributes, last_seen, last_status, last_error)
        VALUES ($1, $2::jsonb, now(), $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
          local_attributes = EXCLUDED.local_attributes,
          last_seen = now(),
          last_status = COALESCE(EXCLUDED.last_status, remotecfg_collectors.last_status),
          last_error = EXCLUDED.last_error,
          updated_at = now()
        `,
        [req.id, JSON.stringify(attrs), status, errorMsg],
      );

      // Assemble and hash the desired config.
      const assembled = await assembleConfigFor(db, attrs);

      const clientHash = req.hash ?? "";
      const unchanged = clientHash !== "" && clientHash === assembled.hash;

      if (!unchanged) {
        await db.query(
          `UPDATE remotecfg_collectors SET last_hash_served = $2 WHERE id = $1`,
          [req.id, assembled.hash],
        );
      }

      return {
        content: unchanged ? "" : assembled.content,
        hash: assembled.hash,
        not_modified: unchanged,
      };
    },

    async registerCollector(
      req: RegisterCollectorRequest,
      ctx?: HandlerCtx,
    ): Promise<RegisterCollectorResponse> {
      if (!req.id || req.id.trim().length === 0) {
        throw new RpcError("invalid_argument", "id is required");
      }
      const attrs: Record<string, string> = {
        ...(req.attributes ?? {}),
        ...(req.local_attributes ?? {}),
      };

      ctx?.log?.debug(
        {
          remotecfg: { id: req.id, name: req.name, attributes: attrs },
        },
        "RegisterCollector",
      );
      await db.query(
        `
        INSERT INTO remotecfg_collectors (id, name, local_attributes, last_seen)
        VALUES ($1, $2, $3::jsonb, now())
        ON CONFLICT (id)
        DO UPDATE SET
          name = COALESCE(EXCLUDED.name, remotecfg_collectors.name),
          local_attributes = EXCLUDED.local_attributes,
          last_seen = now(),
          updated_at = now()
        `,
        [req.id, req.name ?? null, JSON.stringify(attrs)],
      );
      return {};
    },

    async unregisterCollector(
      req: UnregisterCollectorRequest,
    ): Promise<UnregisterCollectorResponse> {
      if (!req.id) {
        throw new RpcError("invalid_argument", "id is required");
      }
      await db.query(`DELETE FROM remotecfg_collectors WHERE id = $1`, [req.id]);
      return {};
    },
  };
}

function mapStatusName(name: string): string | null {
  switch (name) {
    case "RemoteConfigStatuses_APPLIED":
      return "APPLIED";
    case "RemoteConfigStatuses_APPLYING":
      return "APPLYING";
    case "RemoteConfigStatuses_FAILED":
      return "FAILED";
    case "RemoteConfigStatuses_UNSET":
      return "UNSET";
    default:
      return null;
  }
}
