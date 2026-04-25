import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { RolloutEventRequestSchema } from "@fleet/shared";
import type { DbPool } from "../db/pool.js";
import { makeAgentAuth } from "../auth/middleware.js";

export function registerRolloutRoutes(db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const agentAuth = makeAgentAuth(async (collectorId) => {
      const r = await db.query<{ api_key_hash: string }>(
        `SELECT api_key_hash FROM collectors WHERE id = $1`,
        [collectorId],
      );
      return r.rows[0]?.api_key_hash ?? null;
    });

    /** POST /rollout_events/:collector_id */
    app.post("/rollout_events/:collector_id", { preHandler: agentAuth }, async (req, reply) => {
      const { collector_id } = req.params as { collector_id: string };
      const parsed = RolloutEventRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { config_version_id, status, message } = parsed.data;
      await db.query(
        `INSERT INTO rollout_events (config_version_id, collector_id, status, message)
         VALUES ($1, $2, $3, $4)`,
        [config_version_id, collector_id, status, message ?? null],
      );
      return reply.code(204).send();
    });
  };
}
