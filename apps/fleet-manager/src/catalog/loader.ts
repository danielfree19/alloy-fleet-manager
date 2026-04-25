/**
 * Catalog loader.
 *
 * Resolution order (first one that produces a valid file wins):
 *   1. `FLEET_CATALOG_FILE`  — absolute path override for tests / local dev.
 *   2. `FLEET_CATALOG_URL`   — remote HTTP(S) URL (fetched once at startup;
 *                              merged on top of the bundled file so the
 *                              remote can extend OR override by id).
 *   3. bundled file at <repo-root>/catalog/templates.json.
 *
 * The bundled file is ALWAYS the base layer: when the remote URL is
 * set, its templates are merged on top (by `id`) so operators can start
 * from the defaults and add their own without re-declaring everything.
 *
 * Validation uses the same zod schema for both sources, so a malformed
 * remote file surfaces a clear error at startup instead of a runtime
 * crash on first `/catalog` request.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CatalogFileSchema, type CatalogFile, type CatalogTemplate } from "./schema.js";

export interface Catalog {
  templates: CatalogTemplate[];
  sources: string[]; // human-readable, e.g. ["bundled:catalog/templates.json", "remote:https://..."]
}

let cached: Catalog | null = null;

function resolveBundledCatalogPath(): string {
  // Priority 1: explicit env override. Useful for tests and for bundling
  // the catalog into a non-standard path in a custom image.
  const override = process.env["FLEET_CATALOG_FILE"];
  if (override && existsSync(override)) return override;

  // Priority 2: repo-root relative, matching how we resolve the .proto
  // file in `remotecfg/proto.ts`. Walk up from this file:
  //   apps/fleet-manager/src/catalog/loader.ts -> repo root is 4 levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRootPath = resolve(here, "../../../../catalog/templates.json");
  if (existsSync(repoRootPath)) return repoRootPath;

  // Priority 3: inside a built Docker image where `catalog/` is copied
  // next to the compiled app. See Dockerfile runtime stage.
  const imagePath = resolve(process.cwd(), "catalog/templates.json");
  if (existsSync(imagePath)) return imagePath;

  throw new Error(
    `Catalog file not found. Checked: FLEET_CATALOG_FILE=${override ?? "(unset)"}, ${repoRootPath}, ${imagePath}`,
  );
}

function parseCatalog(raw: unknown, source: string): CatalogFile {
  const parsed = CatalogFileSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid catalog from ${source}:\n${msg}`);
  }
  return parsed.data;
}

function loadBundled(): { file: CatalogFile; source: string } {
  const path = resolveBundledCatalogPath();
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return { file: parseCatalog(raw, `bundled:${path}`), source: `bundled:${path}` };
}

async function loadRemote(url: string): Promise<{ file: CatalogFile; source: string }> {
  // Use global fetch (Node 18+). We deliberately do NOT retry — a broken
  // remote catalog should surface immediately at startup, not at first UI
  // request. Bounded timeout keeps a slow remote from stalling boot.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`remote catalog GET ${url} -> ${res.status}`);
    }
    const raw = (await res.json()) as unknown;
    return { file: parseCatalog(raw, `remote:${url}`), source: `remote:${url}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Merge two catalogs: later entries with the same `id` override earlier
 * ones. Preserves insertion order for stable UI listings — overrides
 * keep the original's slot.
 */
function mergeCatalogs(base: CatalogTemplate[], extra: CatalogTemplate[]): CatalogTemplate[] {
  const byId = new Map<string, { idx: number; tmpl: CatalogTemplate }>();
  const result: CatalogTemplate[] = [...base];
  base.forEach((t, i) => byId.set(t.id, { idx: i, tmpl: t }));
  for (const t of extra) {
    const existing = byId.get(t.id);
    if (existing) {
      result[existing.idx] = t;
    } else {
      result.push(t);
    }
  }
  return result;
}

/**
 * Load (and cache) the catalog. Call once at startup; every subsequent
 * call returns the cached value. If you need to force a refresh (e.g.
 * admin `POST /catalog/reload` in a future version), call `resetCatalogCache()`.
 */
export async function loadCatalog(): Promise<Catalog> {
  if (cached) return cached;

  const { file: bundled, source: bundledSrc } = loadBundled();
  const sources = [bundledSrc];
  let templates = bundled.templates;

  const remoteUrl = process.env["FLEET_CATALOG_URL"];
  if (remoteUrl && remoteUrl.trim().length > 0) {
    try {
      const { file: remote, source: remoteSrc } = await loadRemote(remoteUrl.trim());
      templates = mergeCatalogs(templates, remote.templates);
      sources.push(remoteSrc);
    } catch (err) {
      // A broken remote catalog is not allowed to take down the manager.
      // Log loudly and continue with the bundled catalog alone — the
      // reconciler (if any) can keep working.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[catalog] FAILED to load remote catalog from ${remoteUrl}: ${msg}`);
      console.error(`[catalog] continuing with bundled catalog only (${bundled.templates.length} templates)`);
    }
  }

  cached = { templates, sources };
  console.info(
    `[catalog] loaded ${cached.templates.length} templates from ${cached.sources.join(", ")}`,
  );
  return cached;
}

export function resetCatalogCache(): void {
  cached = null;
}

export function findTemplate(catalog: Catalog, id: string): CatalogTemplate | undefined {
  return catalog.templates.find((t) => t.id === id);
}
