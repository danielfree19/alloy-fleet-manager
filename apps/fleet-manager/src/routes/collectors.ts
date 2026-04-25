import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { RegisterRequestSchema } from "@fleet/shared";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeAdminAuth, makeRegistrationAuth } from "../auth/middleware.js";
import { generateApiKey, hashApiKey } from "../auth/tokens.js";

export function registerCollectorRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);
    const regAuth = makeRegistrationAuth(config.REGISTRATION_TOKEN);

    /**
     * POST /collectors/register
     * Agent bootstrap endpoint. Idempotent on (hostname, environment): if a
     * collector already exists we rotate a fresh api_key for it and return it,
     * so re-provisioning a host after losing its state file "just works".
     */
    app.post("/collectors/register", { preHandler: regAuth }, async (req, reply) => {
      const parsed = RegisterRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { hostname, ip, environment, labels } = parsed.data;

      const apiKey = generateApiKey();
      const apiKeyHash = hashApiKey(apiKey);

      const result = await db.query<{ id: string }>(
        `
        INSERT INTO collectors (hostname, ip, environment, labels, api_key_hash, last_seen, status)
        VALUES ($1, $2, $3, $4::jsonb, $5, now(), 'healthy')
        ON CONFLICT (hostname, environment)
        DO UPDATE SET
          ip = EXCLUDED.ip,
          labels = EXCLUDED.labels,
          api_key_hash = EXCLUDED.api_key_hash,
          last_seen = now(),
          status = 'healthy'
        RETURNING id
        `,
        [hostname, ip ?? null, environment, JSON.stringify(labels), apiKeyHash],
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(500).send({ error: "register_failed" });
      }
      return reply.code(200).send({ collector_id: row.id, api_key: apiKey });
    });

    /** GET /collectors  (admin) */
    app.get("/collectors", { preHandler: adminAuth }, async (req) => {
      const q = req.query as { environment?: string; label?: string } | undefined;
      const where: string[] = [];
      const params: unknown[] = [];
      if (q?.environment) {
        params.push(q.environment);
        where.push(`environment = $${params.length}`);
      }
      if (q?.label) {
        // label=key=value
        const [k, ...rest] = q.label.split("=");
        const v = rest.join("=");
        if (k && v) {
          params.push(k);
          params.push(v);
          where.push(`labels ->> $${params.length - 1} = $${params.length}`);
        }
      }
      const sql = `
        SELECT id, hostname, ip, environment, labels, last_seen, status,
               current_config_version, created_at
        FROM collectors
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC
      `;
      const result = await db.query(sql, params);
      return { collectors: result.rows };
    });

    /** GET /collectors/:id  (admin) */
    app.get("/collectors/:id", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await db.query(
        `SELECT id, hostname, ip, environment, labels, last_seen, status,
                current_config_version, created_at
         FROM collectors WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      return row;
    });
  };
}
