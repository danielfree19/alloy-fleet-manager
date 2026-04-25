import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { AssignmentRequestSchema } from "@fleet/shared";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeAdminAuth } from "../auth/middleware.js";
import { renderTemplate, checksum } from "../services/renderer.js";

/**
 * Assignments are the join between a collector and a specific config_version.
 *
 * Per MVP plan: exactly one active assignment per collector (pk on
 * collector_id). Re-assigning simply UPSERTs. To change a collector back to
 * an older version (rollback), call this endpoint again with the older
 * config_version_id — the agent will pick it up on the next poll.
 *
 * When a `label_selector` is provided, we enumerate matching collectors and
 * apply the same config_version_id to each. This is NOT a canary/staged
 * rollout (explicitly deferred), it is an immediate fan-out.
 *
 * We also render the template against the collector's labels at assignment
 * time and replace the rendered_output of the target config_version ONLY if
 * the template contains label placeholders AND the selector targeted exactly
 * one collector — otherwise we assume the snapshot is already correct. For
 * per-collector rendering across many collectors we would need per-collector
 * version rows; that's future work. For MVP the renderer is a no-op for
 * placeholder-free templates, which is the common case.
 */
export function registerAssignmentRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);

    app.post("/assignments", { preHandler: adminAuth }, async (req, reply) => {
      const parsed = AssignmentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
      }
      const { config_version_id, collector_id, label_selector } = parsed.data;

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        // Verify config_version exists and capture its template/checksum.
        const cv = await client.query<{
          config_id: string;
          rendered_output: string;
        }>(
          `SELECT config_id, rendered_output FROM config_versions WHERE id = $1`,
          [config_version_id],
        );
        const cvRow = cv.rows[0];
        if (!cvRow) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "config_version_not_found" });
        }

        // Resolve target collectors.
        let collectors: Array<{ id: string; labels: Record<string, string> }>;
        if (collector_id) {
          const r = await client.query<{ id: string; labels: Record<string, string> }>(
            `SELECT id, labels FROM collectors WHERE id = $1 FOR UPDATE`,
            [collector_id],
          );
          collectors = r.rows;
          if (collectors.length === 0) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: "collector_not_found" });
          }
        } else if (label_selector) {
          // All key=value pairs must match via the `@>` jsonb-contains operator.
          const r = await client.query<{ id: string; labels: Record<string, string> }>(
            `SELECT id, labels FROM collectors WHERE labels @> $1::jsonb FOR UPDATE`,
            [JSON.stringify(label_selector)],
          );
          collectors = r.rows;
          if (collectors.length === 0) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: "no_collectors_match_selector" });
          }
        } else {
          await client.query("ROLLBACK");
          return reply.code(400).send({ error: "bad_request" });
        }

        // Single-collector render path: if the template still contains label
        // placeholders, render against this collector's labels and update the
        // version row in place (the version was just minted for them). For
        // multi-collector assigns we keep the original rendered_output.
        if (collectors.length === 1) {
          const hasPlaceholders = /\{\{\s*label\./.test(cvRow.rendered_output);
          if (hasPlaceholders) {
            const first = collectors[0];
            if (first) {
              const rendered = renderTemplate(cvRow.rendered_output, first.labels);
              await client.query(
                `UPDATE config_versions SET rendered_output = $2, checksum = $3 WHERE id = $1`,
                [config_version_id, rendered, checksum(rendered)],
              );
            }
          }
        }

        for (const c of collectors) {
          await client.query(
            `
            INSERT INTO assignments (collector_id, config_version_id, assigned_at)
            VALUES ($1, $2, now())
            ON CONFLICT (collector_id)
            DO UPDATE SET config_version_id = EXCLUDED.config_version_id, assigned_at = now()
            `,
            [c.id, config_version_id],
          );
          await client.query(
            `UPDATE collectors SET current_config_version = $2 WHERE id = $1`,
            [c.id, config_version_id],
          );
          await client.query(
            `INSERT INTO rollout_events (config_version_id, collector_id, status, message)
             VALUES ($1, $2, 'pending', 'assignment created')`,
            [config_version_id, c.id],
          );
        }

        await client.query("COMMIT");
        return reply.code(200).send({
          assigned: collectors.map((c) => c.id),
          config_version_id,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    });

    /** GET /assignments (admin) */
    app.get("/assignments", { preHandler: adminAuth }, async () => {
      const r = await db.query(
        `SELECT collector_id, config_version_id, assigned_at FROM assignments
         ORDER BY assigned_at DESC`,
      );
      return { assignments: r.rows };
    });
  };
}
