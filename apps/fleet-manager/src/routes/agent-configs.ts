import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { DbPool } from "../db/pool.js";
import { makeAgentAuth } from "../auth/middleware.js";

/**
 * GET /configs/:collector_id  (agent)
 *
 * This is the ONE endpoint the agent polls. We separate it from the admin
 * /configs routes because:
 *   - it uses a different auth scheme (per-collector bearer key), and
 *   - it returns the already-rendered, per-collector output from the
 *     currently assigned config_version.
 */
export function registerAgentConfigRoutes(db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const agentAuth = makeAgentAuth(async (collectorId) => {
      const r = await db.query<{ api_key_hash: string }>(
        `SELECT api_key_hash FROM collectors WHERE id = $1`,
        [collectorId],
      );
      return r.rows[0]?.api_key_hash ?? null;
    });

    // Path is deliberately distinct from /configs/:id (admin) because Fastify
    // treats /configs/:x and /configs/:y as the same route pattern.
    app.get("/agent/configs/:collector_id", { preHandler: agentAuth }, async (req, reply) => {
      const { collector_id } = req.params as { collector_id: string };
      const r = await db.query<{
        config_version_id: string;
        version: number;
        rendered_output: string;
        checksum: string;
      }>(
        `
        SELECT cv.id AS config_version_id, cv.version, cv.rendered_output, cv.checksum
        FROM assignments a
        JOIN config_versions cv ON cv.id = a.config_version_id
        WHERE a.collector_id = $1
        `,
        [collector_id],
      );
      const row = r.rows[0];
      if (!row) return reply.code(404).send({ error: "no_assignment" });
      return row;
    });
  };
}
