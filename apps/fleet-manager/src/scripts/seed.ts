// loadConfig calls loadDotenvFromRepoRoot() internally — no extra dotenv here.
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { checksum } from "../services/renderer.js";
import { sha256 } from "../services/pipeline-assembler.js";
import { generateApiKey, hashApiKey } from "../auth/tokens.js";

/**
 * Dev seed. Creates:
 *   - Two demo pipelines (primary remotecfg path):
 *       * "base-logging"   selector={}                   → applies to everyone
 *       * "edge-metrics"   selector={role:"edge"}        → applies to edge hosts
 *   - One demo legacy config + collector + assignment so the legacy REST agent
 *     still has something to pull.
 *
 * Safe to run repeatedly (uses upserts).
 */
async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // ---- Primary path: pipelines -------------------------------------------
    //
    // Alloy treats the delivered config as a MODULE. Service-level blocks
    // (`logging`, `tracing`, `http`, `remotecfg`) are NOT valid in a module —
    // they must stay in the host's bootstrap.alloy. Pipelines may only contain
    // components (e.g. `prometheus.exporter.*`, `otelcol.*`, `loki.*`).
    const baseSelfMetrics = `// base-self-metrics: always-on self-telemetry, applies to every collector.
prometheus.exporter.self "alloy" { }

prometheus.scrape "self" {
  targets    = prometheus.exporter.self.alloy.targets
  forward_to = []
  scrape_interval = "30s"
}
`;
    const edgeMetrics = `// edge-metrics: node-level exporter, applies only when role=edge.
prometheus.exporter.unix "default" { }

prometheus.scrape "node" {
  targets    = prometheus.exporter.unix.default.targets
  forward_to = []
  scrape_interval = "30s"
}
`;

    await upsertPipeline(client, "base-self-metrics", {}, baseSelfMetrics);
    await upsertPipeline(client, "edge-metrics", { role: "edge" }, edgeMetrics);

    // Remove the old "base-logging" pipeline if it exists — it was invalid
    // (module-level `logging` block is rejected by Alloy).
    await client.query(`DELETE FROM pipelines WHERE name = 'base-logging'`);

    // ---- Legacy path: preserved so the old agent still smokes --------------
    // The legacy agent writes the whole file verbatim to /etc/alloy/config.alloy,
    // so here it's OK to include a root-level `logging` block (the legacy path
    // doesn't use remotecfg modules).
    const legacyLogging = `logging {
  level  = "info"
  format = "logfmt"
}
`;
    const template = legacyLogging + "\n" + edgeMetrics;
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const cfgR = await client.query<{ id: string }>(
      `INSERT INTO configs (name, template) VALUES ('demo-legacy', $1)
       ON CONFLICT (name) DO UPDATE SET template = EXCLUDED.template
       RETURNING id`,
      [template],
    );
    const configId = cfgR.rows[0]?.id;
    if (!configId) throw new Error("config upsert returned no rows");

    const verExisting = await client.query<{ id: string }>(
      `SELECT id FROM config_versions WHERE config_id = $1 AND version = 1`,
      [configId],
    );
    let versionId = verExisting.rows[0]?.id;
    if (!versionId) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO config_versions (config_id, version, rendered_output, checksum)
         VALUES ($1, 1, $2, $3) RETURNING id`,
        [configId, template, checksum(template)],
      );
      versionId = ins.rows[0]?.id;
      if (!versionId) throw new Error("config_version insert returned no rows");
    }

    const colR = await client.query<{ id: string }>(
      `INSERT INTO collectors (hostname, ip, environment, labels, api_key_hash, status, last_seen)
       VALUES ('demo-legacy-host', '127.0.0.1', 'dev', '{"role":"demo"}'::jsonb, $1, 'unknown', now())
       ON CONFLICT (hostname, environment)
       DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash
       RETURNING id`,
      [apiKeyHash],
    );
    const collectorId = colR.rows[0]?.id;
    if (!collectorId) throw new Error("collector upsert returned no rows");

    await client.query(
      `INSERT INTO assignments (collector_id, config_version_id, assigned_at)
       VALUES ($1, $2, now())
       ON CONFLICT (collector_id)
       DO UPDATE SET config_version_id = EXCLUDED.config_version_id, assigned_at = now()`,
      [collectorId, versionId],
    );
    await client.query(
      `UPDATE collectors SET current_config_version = $2 WHERE id = $1`,
      [collectorId, versionId],
    );

    await client.query("COMMIT");

    // eslint-disable-next-line no-console
    console.log("Seeded:");
    // eslint-disable-next-line no-console
    console.log("  primary pipelines:  base-self-metrics (selector={}), edge-metrics (selector={role:edge})");
    // eslint-disable-next-line no-console
    console.log("  legacy collector_id =", collectorId);
    // eslint-disable-next-line no-console
    console.log("  legacy api_key      =", apiKey);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

async function upsertPipeline(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  name: string,
  selector: Record<string, string>,
  content: string,
) {
  const hash = sha256(content);
  const r = (await client.query(
    `
    INSERT INTO pipelines (name, selector, enabled, current_version, current_content, current_hash)
    VALUES ($1, $2::jsonb, true, 1, $3, $4)
    ON CONFLICT (name) DO UPDATE SET
      selector = EXCLUDED.selector,
      current_content = EXCLUDED.current_content,
      current_hash = EXCLUDED.current_hash,
      current_version = pipelines.current_version + CASE
        WHEN pipelines.current_content != EXCLUDED.current_content
           OR pipelines.selector != EXCLUDED.selector
        THEN 1 ELSE 0 END,
      updated_at = now()
    RETURNING id, current_version
    `,
    [name, JSON.stringify(selector), content, hash],
  )) as { rows: Array<{ id: string; current_version: number }> };
  const row = r.rows[0];
  if (!row) throw new Error(`upsert pipeline ${name} returned no rows`);
  await client.query(
    `
    INSERT INTO pipeline_versions (pipeline_id, version, content, hash, selector)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (pipeline_id, version) DO NOTHING
    `,
    [row.id, row.current_version, content, hash, JSON.stringify(selector)],
  );
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
