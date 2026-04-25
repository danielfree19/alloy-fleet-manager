/**
 * Read-only admin surface for the pipeline template catalog.
 *
 * The catalog is loaded once at startup (see `catalog/loader.ts`) and
 * cached in-process; these handlers are thin wrappers around the cache.
 * No mutation endpoints here — editing the catalog means editing
 * `catalog/templates.json` (bundled) or the `FLEET_CATALOG_URL` target.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import { makeAdminAuth } from "../auth/middleware.js";
import { loadCatalog, findTemplate } from "../catalog/loader.js";

export function registerCatalogRoutes(config: AppConfig): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const adminAuth = makeAdminAuth(config.ADMIN_TOKEN);

    /**
     * List templates. Returns lightweight entries without the `content`
     * field so the UI catalog grid stays small even with dozens of
     * templates. Use GET /catalog/:id to retrieve the full template.
     */
    app.get("/catalog", { preHandler: adminAuth }, async () => {
      const catalog = await loadCatalog();
      const entries = catalog.templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        tags: t.tags,
        default_selector: t.default_selector,
        suggested_name: t.suggested_name ?? null,
        docs_url: t.docs_url ?? null,
        requires: t.requires,
      }));
      return { sources: catalog.sources, templates: entries };
    });

    /**
     * Full template, including `content`. Used by the UI "install"
     * flow when pre-filling the new-pipeline form, and by the SDK /
     * fleetctl when scripting pipeline creation from templates.
     */
    app.get<{ Params: { id: string } }>(
      "/catalog/:id",
      { preHandler: adminAuth },
      async (req, reply) => {
        const catalog = await loadCatalog();
        const template = findTemplate(catalog, req.params.id);
        if (!template) {
          return reply.code(404).send({ error: "not_found", id: req.params.id });
        }
        return { template };
      },
    );
  };
}
