import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { HeartbeatRequestSchema } from "@fleet/shared";
import type { DbPool } from "../db/pool.js";
import { makeAgentAuth } from "../auth/middleware.js";

export function registerHeartbeatRoutes(db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const agentAuth = makeAgentAuth(async (collectorId) => {
      const r = await db.query<{ api_key_hash: string }>(
        `SELECT api_key_hash FROM collectors WHERE id = $1`,
        [collectorId],
      );
      return r.rows[0]?.api_key_hash ?? null;
    });

    /** POST /heartbeats/:collector_id */
    app.post("/heartbeats/:collector_id", { preHandler: agentAuth }, async (req, reply) => {
      const { collector_id } = req.params as { collector_id: string };
      const parsed = HeartbeatRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { status, message, reported_version } = parsed.data;

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO heartbeats (collector_id, status, message, reported_version)
           VALUES ($1, $2, $3, $4)`,
          [collector_id, status, message ?? null, reported_version ?? null],
        );
        await client.query(
          `UPDATE collectors SET last_seen = now(), status = $2 WHERE id = $1`,
          [collector_id, status],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return reply.code(204).send();
    });
  };
}
