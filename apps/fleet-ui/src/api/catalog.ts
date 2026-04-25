import { apiFetch } from "./client";
import type { CatalogListResponse, CatalogTemplate } from "./types";

/** List all available templates (metadata only; no `content`). */
export async function listCatalog(): Promise<CatalogListResponse> {
  return apiFetch<CatalogListResponse>("/catalog");
}

/** Fetch a single template including its full Alloy `content`. */
export async function getCatalogTemplate(id: string): Promise<CatalogTemplate> {
  const r = await apiFetch<{ template: CatalogTemplate }>(`/catalog/${id}`);
  return r.template;
}
