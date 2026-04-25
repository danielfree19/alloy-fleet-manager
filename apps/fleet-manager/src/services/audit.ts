/**
 * Audit log helper. One entry point — `recordAuditEvent` — used by the
 * pipeline routes to persist a single row per admin mutation inside the
 * same transaction as the mutation itself.
 *
 * Keeping this a thin wrapper (and not, say, a Fastify plugin with hooks)
 * is deliberate: the audit event for a PATCH needs BOTH the before-state
 * and the after-state, which we already have locally in the route
 * handler. Trying to synthesize that from an `onResponse` hook would miss
 * context.
 */

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { DbPool } from "../db/pool.js";

export type AuditAction =
  | "pipeline.create"
  | "pipeline.update"
  | "pipeline.delete";

export interface AuditEventInput {
  actor: string;
  action: AuditAction;
  target_kind: "pipeline";
  target_id: string | null;
  target_name: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  created_at: string;
  actor: string;
  action: AuditAction;
  target_kind: string;
  target_id: string | null;
  target_name: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Insert a single audit row. Accepts either a live `PoolClient` (so the
 * caller's BEGIN/COMMIT transaction is preserved) or the top-level pool.
 */
export async function recordAuditEvent(
  runner: DbPool | PoolClient,
  evt: AuditEventInput,
): Promise<void> {
  await runner.query(
    `
    INSERT INTO audit_events (actor, action, target_kind, target_id, target_name, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      evt.actor,
      evt.action,
      evt.target_kind,
      evt.target_id,
      evt.target_name,
      JSON.stringify(evt.metadata ?? {}),
    ],
  );
}

/**
 * Derive a stable, non-reversible identifier for the admin caller from
 * their bearer token. We don't want to log raw tokens in the audit table
 * (they're secrets), but knowing whether two events came from the same
 * token is valuable. Hash + first 8 hex chars is enough for
 * disambiguation — collisions are acceptably rare.
 */
export function actorFromToken(token: string | undefined | null): string {
  if (!token) return "anonymous";
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 8);
  return `admin-token:${digest}`;
}

/**
 * Diff two pipeline snapshots and return the list of fields that changed.
 * Used to keep the audit metadata small (we don't want every content blob
 * in the log) while still saying "this update changed `selector`".
 */
export interface PipelineSnapshot {
  selector: Record<string, string>;
  enabled: boolean;
  content: string;
}

export function diffPipeline(
  before: PipelineSnapshot,
  after: PipelineSnapshot,
): string[] {
  const changed: string[] = [];
  if (JSON.stringify(before.selector) !== JSON.stringify(after.selector)) {
    changed.push("selector");
  }
  if (before.enabled !== after.enabled) changed.push("enabled");
  if (before.content !== after.content) changed.push("content");
  return changed;
}
