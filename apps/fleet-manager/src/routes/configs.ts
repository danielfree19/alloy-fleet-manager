import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  CreateConfigRequestSchema,
  CreateConfigVersionRequestSchema,
  ValidateConfigRequestSchema,
} from "@fleet/shared";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeAdminAuth } from "../auth/middleware.js";
import { checksum } from "../services/renderer.js";
import { validateAlloyTemplate } from "../services/validator.js";

export function registerConfigRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);

    /** POST /configs (admin) — create a named template and an initial version 1. */
    app.post("/configs", { preHandler: adminAuth }, async (req, reply) => {
      const parsed = CreateConfigRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { name, template } = parsed.data;

      const validation = validateAlloyTemplate(template);
      if (!validation.valid) {
        return reply.code(400).send({ error: "invalid_template", details: validation.errors });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const cfg = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO configs (name, template) VALUES ($1, $2)
           RETURNING id, created_at`,
          [name, template],
        );
        const cfgRow = cfg.rows[0];
        if (!cfgRow) throw new Error("insert configs returned no rows");

        // Note: MVP renderer is pass-through at creation time. Rendering for
        // a specific collector happens at assignment time (see assignments).
        const rendered = template;
        const ver = await client.query<{ id: string; version: number; created_at: string }>(
          `INSERT INTO config_versions (config_id, version, rendered_output, checksum)
           VALUES ($1, 1, $2, $3)
           RETURNING id, version, created_at`,
          [cfgRow.id, rendered, checksum(rendered)],
        );
        await client.query("COMMIT");
        const verRow = ver.rows[0];
        if (!verRow) throw new Error("insert config_versions returned no rows");
        return reply.code(201).send({
          config: { id: cfgRow.id, name, template, created_at: cfgRow.created_at },
          initial_version: {
            id: verRow.id,
            config_id: cfgRow.id,
            version: verRow.version,
            created_at: verRow.created_at,
          },
        });
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        const pgErr = err as { code?: string; message?: string };
        if (pgErr?.code === "23505") {
          return reply.code(409).send({ error: "config_name_taken" });
        }
        throw err;
      } finally {
        client.release();
      }
    });

    /** GET /configs (admin) */
    app.get("/configs", { preHandler: adminAuth }, async () => {
      const result = await db.query(
        `SELECT id, name, template, created_at FROM configs ORDER BY created_at DESC`,
      );
      return { configs: result.rows };
    });

    /** GET /configs/:id (admin) with versions summary */
    app.get("/configs/:id", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const cfg = await db.query(
        `SELECT id, name, template, created_at FROM configs WHERE id = $1`,
        [id],
      );
      const cfgRow = cfg.rows[0];
      if (!cfgRow) return reply.code(404).send({ error: "not_found" });
      const versions = await db.query(
        `SELECT id, version, checksum, created_at
         FROM config_versions WHERE config_id = $1 ORDER BY version DESC`,
        [id],
      );
      return { config: cfgRow, versions: versions.rows };
    });

    /**
     * POST /configs/:id/versions (admin)
     * Body is optional; if omitted, the latest template on the config row is
     * used as the source. If the body provides a new `template`, we update
     * the template on the config and create a new version pinned to that text.
     * Version numbers are monotonically increasing per config_id.
     */
    app.post("/configs/:id/versions", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateConfigVersionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const cfg = await client.query<{ template: string }>(
          `SELECT template FROM configs WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const cfgRow = cfg.rows[0];
        if (!cfgRow) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        let tmpl = cfgRow.template;
        if (parsed.data.template) {
          tmpl = parsed.data.template;
          const v = validateAlloyTemplate(tmpl);
          if (!v.valid) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "invalid_template", details: v.errors });
          }
          await client.query(`UPDATE configs SET template = $2 WHERE id = $1`, [id, tmpl]);
        }
        const next = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM config_versions WHERE config_id = $1`,
          [id],
        );
        const nextVer = next.rows[0]?.next ?? 1;
        const ins = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO config_versions (config_id, version, rendered_output, checksum)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [id, nextVer, tmpl, checksum(tmpl)],
        );
        await client.query("COMMIT");
        const verRow = ins.rows[0];
        if (!verRow) throw new Error("insert config_versions returned no rows");
        return reply.code(201).send({
          id: verRow.id,
          config_id: id,
          version: nextVer,
          checksum: checksum(tmpl),
          created_at: verRow.created_at,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    /** POST /configs/validate (admin) — MVP syntax check. */
    app.post("/configs/validate", { preHandler: adminAuth }, async (req, reply) => {
      const parsed = ValidateConfigRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const result = validateAlloyTemplate(parsed.data.template);
      return reply.code(result.valid ? 200 : 400).send(result);
    });
  };
}
