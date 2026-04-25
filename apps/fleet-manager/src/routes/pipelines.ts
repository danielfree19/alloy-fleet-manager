import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  CreatePipelineRequestSchema,
  UpdatePipelineRequestSchema,
} from "@fleet/shared";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeAdminAuth } from "../auth/middleware.js";
import { validateAlloyTemplateStrict } from "../services/validator.js";
import { sha256, assembleConfigFor } from "../services/pipeline-assembler.js";
import { diffPipeline, recordAuditEvent } from "../services/audit.js";

/**
 * Admin REST surface for managing `pipelines`. Every mutation also writes an
 * immutable row to `pipeline_versions` so history and rollback are always
 * available.
 */
export function registerPipelineRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);

    app.post("/pipelines", { preHandler: adminAuth }, async (req, reply) => {
      const parsed = CreatePipelineRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { name, selector, content, enabled } = parsed.data;

      // Strict: falls back to the builtin brace check if `alloy fmt` isn't on
      // the image (see services/validator.ts). Either way, bad syntax gets
      // rejected before we ever write to the DB.
      const v = await validateAlloyTemplateStrict(content);
      if (!v.valid) {
        return reply.code(400).send({
          error: "invalid_template",
          engine: v.engine,
          details: v.errors,
        });
      }
      const hash = sha256(content);

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query<{ id: string; created_at: string; updated_at: string }>(
          `
          INSERT INTO pipelines (name, selector, enabled, current_version, current_content, current_hash)
          VALUES ($1, $2::jsonb, $3, 1, $4, $5)
          RETURNING id, created_at, updated_at
          `,
          [name, JSON.stringify(selector), enabled, content, hash],
        );
        const row = r.rows[0];
        if (!row) throw new Error("insert pipelines returned no rows");
        await client.query(
          `
          INSERT INTO pipeline_versions (pipeline_id, version, content, hash, selector)
          VALUES ($1, 1, $2, $3, $4::jsonb)
          `,
          [row.id, content, hash, JSON.stringify(selector)],
        );
        await recordAuditEvent(client, {
          actor: req.adminActor ?? "admin",
          action: "pipeline.create",
          target_kind: "pipeline",
          target_id: row.id,
          target_name: name,
          metadata: {
            selector,
            enabled,
            version: 1,
            hash,
            content_bytes: content.length,
          },
        });
        await client.query("COMMIT");
        return reply.code(201).send({
          id: row.id,
          name,
          selector,
          enabled,
          current_version: 1,
          current_content: content,
          current_hash: hash,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      } catch (err: unknown) {
        await client.query("ROLLBACK");
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          return reply.code(409).send({ error: "pipeline_name_taken" });
        }
        throw err;
      } finally {
        client.release();
      }
    });

    app.get("/pipelines", { preHandler: adminAuth }, async () => {
      const r = await db.query(
        `SELECT id, name, selector, enabled, current_version, current_content, current_hash,
                created_at, updated_at
         FROM pipelines ORDER BY name`,
      );
      return { pipelines: r.rows };
    });

    app.get("/pipelines/:id", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = await db.query(
        `SELECT id, name, selector, enabled, current_version, current_content, current_hash,
                created_at, updated_at FROM pipelines WHERE id = $1`,
        [id],
      );
      const pRow = p.rows[0];
      if (!pRow) return reply.code(404).send({ error: "not_found" });
      const v = await db.query(
        `SELECT id, version, hash, selector, created_at FROM pipeline_versions
         WHERE pipeline_id = $1 ORDER BY version DESC`,
        [id],
      );
      return { pipeline: pRow, versions: v.rows };
    });

    app.patch("/pipelines/:id", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdatePipelineRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const patch = parsed.data;

      if (patch.content !== undefined) {
        const v = await validateAlloyTemplateStrict(patch.content);
        if (!v.valid) {
          return reply.code(400).send({
            error: "invalid_template",
            engine: v.engine,
            details: v.errors,
          });
        }
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const cur = await client.query<{
          name: string;
          current_content: string;
          current_version: number;
          selector: Record<string, string>;
          enabled: boolean;
        }>(
          `SELECT name, current_content, current_version, selector, enabled
           FROM pipelines WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const curRow = cur.rows[0];
        if (!curRow) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }

        const nextContent = patch.content ?? curRow.current_content;
        const nextSelector = patch.selector ?? curRow.selector;
        const nextEnabled = patch.enabled ?? curRow.enabled;

        // Only bump version when content or selector actually changed.
        const contentChanged = nextContent !== curRow.current_content;
        const selectorChanged =
          JSON.stringify(nextSelector) !== JSON.stringify(curRow.selector);

        if (contentChanged || selectorChanged) {
          const nextVersion = curRow.current_version + 1;
          const hash = sha256(nextContent);
          await client.query(
            `
            UPDATE pipelines SET
              current_content = $2,
              current_version = $3,
              current_hash = $4,
              selector = $5::jsonb,
              enabled = $6,
              updated_at = now()
            WHERE id = $1
            `,
            [id, nextContent, nextVersion, hash, JSON.stringify(nextSelector), nextEnabled],
          );
          await client.query(
            `
            INSERT INTO pipeline_versions (pipeline_id, version, content, hash, selector)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            `,
            [id, nextVersion, nextContent, hash, JSON.stringify(nextSelector)],
          );
        } else if (nextEnabled !== curRow.enabled) {
          await client.query(
            `UPDATE pipelines SET enabled = $2, updated_at = now() WHERE id = $1`,
            [id, nextEnabled],
          );
        }

        // Record the audit row after the data change, still inside the same
        // transaction. If nothing actually changed (e.g. a no-op PATCH with
        // identical fields) we still emit an event — operators want to see
        // "who touched this and when" even if the effect was a no-op.
        const changedFields = diffPipeline(
          {
            selector: curRow.selector,
            enabled: curRow.enabled,
            content: curRow.current_content,
          },
          {
            selector: nextSelector,
            enabled: nextEnabled,
            content: nextContent,
          },
        );
        await recordAuditEvent(client, {
          actor: req.adminActor ?? "admin",
          action: "pipeline.update",
          target_kind: "pipeline",
          target_id: id,
          target_name: curRow.name,
          metadata: {
            changed_fields: changedFields,
            before: {
              selector: curRow.selector,
              enabled: curRow.enabled,
              version: curRow.current_version,
            },
            after: {
              selector: nextSelector,
              enabled: nextEnabled,
              version:
                contentChanged || selectorChanged
                  ? curRow.current_version + 1
                  : curRow.current_version,
            },
          },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const r = await db.query(
        `SELECT id, name, selector, enabled, current_version, current_content, current_hash,
                created_at, updated_at FROM pipelines WHERE id = $1`,
        [id],
      );
      return reply.code(200).send(r.rows[0]);
    });

    app.delete("/pipelines/:id", { preHandler: adminAuth }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Capture `name` + selector before the cascade delete so the audit
        // row can reference it after the fact. The DELETE ... RETURNING
        // gives us both in one round-trip.
        const del = await client.query<{
          name: string;
          selector: Record<string, string>;
          current_version: number;
        }>(
          `DELETE FROM pipelines WHERE id = $1
           RETURNING name, selector, current_version`,
          [id],
        );
        if (del.rowCount === 0) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "not_found" });
        }
        const delRow = del.rows[0]!;
        await recordAuditEvent(client, {
          actor: req.adminActor ?? "admin",
          action: "pipeline.delete",
          target_kind: "pipeline",
          target_id: id,
          target_name: delRow.name,
          metadata: {
            selector: delRow.selector,
            last_version: delRow.current_version,
          },
        });
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    /**
     * Preflight validator. Lets the UI (and fleetctl/terraform) run the
     * same strict check the write path runs, without committing anything.
     * Never touches the DB.
     *
     * Request body: { content: string }
     * Response: { valid: boolean, errors: string[], engine: "alloy-fmt" | "builtin" }
     */
    app.post("/pipelines/validate", { preHandler: adminAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { content?: unknown };
      if (typeof body.content !== "string") {
        return reply.code(400).send({ error: "bad_request", details: "content must be a string" });
      }
      const result = await validateAlloyTemplateStrict(body.content);
      return result;
    });

    /**
     * Admin preview endpoint. Given a set of hypothetical collector
     * attributes, return the config the manager WOULD serve to a real
     * collector reporting those attributes. Used by the UI's selector
     * builder to show operators which pipelines would match.
     *
     * NOTE: this is side-effect free — it never touches the
     * remotecfg_collectors table. Unlike the Connect `GetConfig` RPC, no
     * upsert happens.
     */
    app.post("/pipelines/assemble", { preHandler: adminAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { attributes?: Record<string, unknown> };
      const rawAttrs = body.attributes ?? {};
      if (typeof rawAttrs !== "object" || Array.isArray(rawAttrs)) {
        return reply.code(400).send({ error: "attributes must be an object" });
      }
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (typeof v !== "string") {
          return reply
            .code(400)
            .send({ error: `attribute ${k} must be a string, got ${typeof v}` });
        }
        attrs[k] = v;
      }
      const assembled = await assembleConfigFor(db, attrs);
      return assembled;
    });

    /** List registered Alloy collectors seen via remotecfg. */
    app.get("/remotecfg/collectors", { preHandler: adminAuth }, async () => {
      const r = await db.query(
        `SELECT id, name, local_attributes, last_seen, last_status, last_error,
                last_hash_served, created_at, updated_at
         FROM remotecfg_collectors ORDER BY last_seen DESC`,
      );
      return { collectors: r.rows };
    });
  };
}
