import { apiFetch } from "./client";
import type { AuditEvent, ListAuditFilter } from "./types";

/**
 * Fetch audit events. The server accepts the same filter fields as
 * `GET /audit?...`; we pass through every non-empty value.
 */
export async function listAuditEvents(filter: ListAuditFilter = {}): Promise<AuditEvent[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const path = `/audit${qs.size ? "?" + qs.toString() : ""}`;
  const r = await apiFetch<{ events: AuditEvent[]; limit: number }>(path);
  return r.events;
}
