import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeAdminAuth } from "../auth/middleware.js";

/**
 * Read-only audit surface. Writes happen inline with the mutations
 * (see `services/audit.ts`); this file only exposes list/filter.
 */
export function registerAuditRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);

    /**
     * List audit events, most recent first.
     *
     * Query params (all optional):
     *   target_kind  — "pipeline"
     *   target_id    — UUID string, filters history for one object
     *   action       — "pipeline.create" | "pipeline.update" | "pipeline.delete"
     *   actor        — partial match (LIKE %actor%) on the stored actor id
     *   limit        — 1..500, default 100
     *   before       — RFC3339 timestamp; return rows strictly older than this
     *                  (pagination cursor)
     */
    app.get("/audit", { preHandler: adminAuth }, async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, string | undefined>;

      const where: string[] = [];
      const params: unknown[] = [];
      const push = (clause: string, val: unknown) => {
        params.push(val);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (q.target_kind) push("target_kind = $?", q.target_kind);
      if (q.target_id) push("target_id = $?", q.target_id);
      if (q.action) push("action = $?", q.action);
      if (q.actor) push("actor ILIKE $?", `%${q.actor}%`);
      if (q.before) {
        const parsed = Date.parse(q.before);
        if (Number.isNaN(parsed)) {
          return reply.code(400).send({ error: "bad_request", details: "before must be RFC3339" });
        }
        push("created_at < $?", new Date(parsed).toISOString());
      }

      const limit = Math.min(Math.max(parseInt(q.limit ?? "100", 10) || 100, 1), 500);

      const sql = `
        SELECT id, created_at, actor, action, target_kind, target_id, target_name, metadata
        FROM audit_events
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      const r = await db.query(sql, params);
      return { events: r.rows, limit };
    });
  };
}
