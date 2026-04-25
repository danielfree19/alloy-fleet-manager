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
import type { Actor } from "../auth/permissions.js";

export type AuditAction =
  // Pipelines (Phase 0)
  | "pipeline.create"
  | "pipeline.update"
  | "pipeline.delete"
  // Identity / RBAC (Phase 1)
  | "auth.login"
  | "auth.login.locked"
  | "auth.logout"
  | "auth.password.change"
  | "user.create"
  | "user.update"
  | "user.delete"
  | "user.unlock"
  | "user.password.reset"
  | "role.create"
  | "role.update"
  | "role.delete"
  | "token.create"
  | "token.revoke"
  // SSO (Phase 2). These are emitted in addition to (not instead of)
  // the regular `auth.login` row when a user signs in via OIDC, so
  // an auditor querying by `auth.login` still sees every interactive
  // sign-in regardless of mechanism.
  | "auth.sso.login"
  | "auth.sso.rejected"
  | "auth.sso.role_sync"
  | "sso.provider.create"
  | "sso.provider.update"
  | "sso.provider.delete"
  | "sso.provider.test"
  | "sso.user_link"
  | "sso.user_unlink";

/**
 * Audit `target_kind` is the noun the action operates on. Plain text
 * in the DB so adding a new kind here doesn't require a schema change;
 * we keep the union narrow on the TS side as a guardrail against
 * typos.
 */
export type AuditTargetKind =
  | "pipeline"
  | "user"
  | "role"
  | "api_token"
  // SSO. `sso_provider` is the configured identity provider row;
  // the rejected-callback events use `user` with `target_id = null`
  // and `target_name = email_or_subject` so the existing /audit UI
  // doesn't need a new view.
  | "sso_provider";

export interface AuditEventInput {
  /** Legacy human-readable identifier (e.g. "user:alice@x.com"). Always populated. */
  actor: string;
  action: AuditAction;
  target_kind: AuditTargetKind;
  target_id: string | null;
  target_name: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Structured actor context — added with the identity migration. Old
   * call sites that still pass only `actor` continue to work; new
   * code (or anything that has a resolved Actor on hand) should pass
   * the structured fields too.
   */
  actor_kind?: "env_token" | "user" | "api_token" | null;
  actor_user_id?: string | null;
  actor_email?: string | null;
  actor_token_id?: string | null;
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
  actor_kind: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_token_id: string | null;
}

/**
 * Insert a single audit row. Accepts either a live `PoolClient` (so the
 * caller's BEGIN/COMMIT transaction is preserved) or the top-level pool.
 *
 * Metadata is run through `sanitizeAuditMetadata` so a future contributor
 * who accidentally includes a plaintext secret in `metadata` doesn't
 * leak it into the audit table — the row is the wrong place for secrets
 * because operators routinely export it for compliance reviews.
 */
export async function recordAuditEvent(
  runner: DbPool | PoolClient,
  evt: AuditEventInput,
): Promise<void> {
  const safeMetadata = sanitizeAuditMetadata(evt.metadata ?? {});
  await runner.query(
    `
    INSERT INTO audit_events (
      actor, action, target_kind, target_id, target_name, metadata,
      actor_kind, actor_user_id, actor_email, actor_token_id
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
    `,
    [
      evt.actor,
      evt.action,
      evt.target_kind,
      evt.target_id,
      evt.target_name,
      JSON.stringify(safeMetadata),
      evt.actor_kind ?? null,
      evt.actor_user_id ?? null,
      evt.actor_email ?? null,
      evt.actor_token_id ?? null,
    ],
  );
}

/**
 * Audit-metadata sanitizer.
 *
 * Walks the metadata object and replaces values at any key that looks
 * like a secret with `"[redacted]"`. The deny-list is keyed on exact
 * property names, not regex against the value, because audit metadata
 * routinely contains free-form text (target_name etc.) where a regex
 * over content would have too many false positives.
 *
 * Known-safe identifiers that contain `token`/`secret` substrings —
 * `token_prefix`, `token_id`, `actor_token_id`, `session_id` — are
 * NOT redacted; the deny-list is exact-match only.
 *
 * In development (`NODE_ENV !== "production"`) we additionally THROW
 * on any forbidden key so tests catch a contributor accidentally
 * stashing a secret in metadata. In production we redact silently —
 * an audit row with `[redacted]` is strictly better than either
 * leaking the secret or blowing up the surrounding transaction.
 */
const FORBIDDEN_METADATA_KEYS: ReadonlySet<string> = new Set([
  "password",
  "current_password",
  "new_password",
  "old_password",
  "password_hash",
  "client_secret",
  "secret",
  "token",
  "token_hash",
  "api_key",
  "api_secret",
  "private_key",
]);

export function sanitizeAuditMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const isProd = process.env.NODE_ENV === "production";
  return walk(input, isProd, "") as Record<string, unknown>;
}

function walk(value: unknown, isProd: boolean, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, isProd, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${k}` : k;
      if (FORBIDDEN_METADATA_KEYS.has(k)) {
        if (!isProd) {
          throw new Error(
            `audit metadata contains forbidden key '${childPath}'. ` +
              `Audit rows are exported for compliance review and must never ` +
              `carry plaintext secrets. Use a non-secret descriptor (e.g. token_prefix) instead.`,
          );
        }
        out[k] = "[redacted]";
        continue;
      }
      out[k] = walk(v, isProd, childPath);
    }
    return out;
  }
  return value;
}

/**
 * Helper: derive every audit-event field from a resolved Actor.
 * Lets routes write `recordAuditEvent(client, { ...auditFieldsFromActor(req.actor!), action, ... })`
 * without repeating the actor → fields mapping at every call site.
 */
export function auditFieldsFromActor(actor: Actor): Pick<
  AuditEventInput,
  "actor" | "actor_kind" | "actor_user_id" | "actor_email" | "actor_token_id"
> {
  let actorString: string;
  switch (actor.kind) {
    case "env_token":
      actorString = "admin-token:env";
      break;
    case "user":
      actorString = `user:${actor.email ?? actor.userId ?? "unknown"}`;
      break;
    case "api_token":
      actorString = `api-token:${actor.apiTokenId ?? "unknown"}`;
      break;
  }
  return {
    actor: actorString,
    actor_kind: actor.kind,
    actor_user_id: actor.userId,
    actor_email: actor.email,
    actor_token_id: actor.apiTokenId,
  };
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
