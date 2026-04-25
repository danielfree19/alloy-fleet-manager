/**
 * Wire-level DTOs for the Fleet Manager admin API.
 *
 * These mirror the Postgres-backed row shapes the manager returns. They're
 * kept deliberately minimal (plain interfaces, no classes, no runtime
 * dependency) so the SDK can be consumed from both Node and browsers and
 * so the Terraform provider / CLI can keep their Go DTOs in sync by eye.
 */

export type Labels = Record<string, string>;

export interface Pipeline {
  id: string;
  name: string;
  selector: Labels;
  enabled: boolean;
  current_version: number;
  current_content: string;
  current_hash: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineVersion {
  id: string;
  version: number;
  hash: string;
  selector: Labels;
  created_at: string;
}

export interface PipelineDetail {
  pipeline: Pipeline;
  versions: PipelineVersion[];
}

export type RemotecfgStatus = "UNSET" | "APPLIED" | "APPLYING" | "FAILED" | null;

export interface RemotecfgCollector {
  id: string;
  name: string | null;
  local_attributes: Labels;
  last_seen: string | null;
  last_status: RemotecfgStatus;
  last_error: string | null;
  last_hash_served: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssembledConfig {
  content: string;
  hash: string;
  pipeline_names: string[];
}

export interface CreatePipelineInput {
  name: string;
  selector: Labels;
  enabled: boolean;
  content: string;
}

export interface UpdatePipelineInput {
  selector?: Labels;
  enabled?: boolean;
  content?: string;
}

export type AuditAction =
  // Pipelines
  | "pipeline.create"
  | "pipeline.update"
  | "pipeline.delete"
  // Identity / RBAC
  | "auth.login"
  | "auth.logout"
  | "auth.password.change"
  | "user.create"
  | "user.update"
  | "user.delete"
  | "user.password.reset"
  | "role.create"
  | "role.update"
  | "role.delete"
  | "token.create"
  | "token.revoke"
  // SSO (Phase 2)
  | "auth.sso.login"
  | "auth.sso.rejected"
  | "auth.sso.role_sync"
  | "sso.provider.create"
  | "sso.provider.update"
  | "sso.provider.delete"
  | "sso.provider.test"
  | "sso.user_link"
  | "sso.user_unlink";

export type AuditTargetKind =
  | "pipeline"
  | "user"
  | "role"
  | "api_token"
  | "sso_provider";

export interface AuditEvent {
  id: string;
  created_at: string;
  actor: string;
  action: AuditAction;
  /** Plain text on the wire so the SDK keeps working when the manager adds a new kind. */
  target_kind: AuditTargetKind | string;
  target_id: string | null;
  target_name: string | null;
  metadata: Record<string, unknown>;
  // Structured actor columns added with the identity migration. Older
  // pre-identity rows leave them null.
  actor_kind?: "env_token" | "user" | "api_token" | null;
  actor_user_id?: string | null;
  actor_email?: string | null;
  actor_token_id?: string | null;
}

export interface ListAuditFilter {
  target_kind?: string;
  target_id?: string;
  action?: AuditAction;
  actor?: string;
  /** RFC3339 cursor — returns rows strictly older than this. */
  before?: string;
  /** 1..500; default 100 server-side. */
  limit?: number;
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  engine?: "builtin" | "alloy-fmt";
}

export type CatalogCategory = "metrics" | "logs" | "traces" | "sinks" | "infra";

export interface CatalogTemplateSummary {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  tags: string[];
  default_selector: Labels;
  suggested_name: string | null;
  docs_url: string | null;
  requires: string[];
}

export interface CatalogTemplate extends CatalogTemplateSummary {
  content: string;
}

export interface CatalogListResponse {
  sources: string[];
  templates: CatalogTemplateSummary[];
}

// ---------------------------------------------------------------------------
// Identity / RBAC
// ---------------------------------------------------------------------------
//
// Mirrors the manager's `auth/permissions.ts` and `routes/users.ts` /
// `routes/tokens.ts` shapes. Strings (not enums) for forward-compat: the
// SDK should keep working when the manager adds a permission.

/**
 * Canonical permission strings recognized by the manager today. Open union
 * (`(string & {})`) so callers can hold permissions added in newer manager
 * versions without us shipping a new SDK release.
 */
export type Permission =
  | "pipelines.read"
  | "pipelines.create"
  | "pipelines.update"
  | "pipelines.delete"
  | "collectors.read"
  | "collectors.poll"
  | "catalog.read"
  | "audit.read"
  | "users.read"
  | "users.write"
  | "tokens.read"
  | "tokens.write"
  | "sso.read"
  | "sso.write"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Built-in roles shipped by the manager. Custom roles use arbitrary names. */
export type BuiltinRoleName = "admin" | "editor" | "viewer" | "agent";

export interface Role {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  permissions: Permission[];
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permissions: Permission[];
}

export interface UpdateRoleInput {
  description?: string | null;
  permissions?: Permission[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  disabled: boolean;
  created_at: string;
  updated_at: string;
  roles: Pick<Role, "id" | "name">[];
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password: string;
  role_ids: string[];
  disabled?: boolean;
}

export interface UpdateUserInput {
  name?: string | null;
  disabled?: boolean;
  role_ids?: string[];
}

/**
 * The "who am I" reply from `/auth/me`. `kind` reflects how the caller
 * authenticated to *this* request — env-token actors (the legacy
 * `ADMIN_TOKEN`) have no `userId`.
 */
export interface MeResponse {
  kind: "env_token" | "user" | "api_token";
  userId: string | null;
  email: string | null;
  permissions: Permission[];
  roles: string[];
  tokenId?: string | null;
}

/** A row in `GET /tokens` (or `/users/:id/tokens`). Plaintext is never returned here. */
export interface ApiTokenSummary {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  roles: Pick<Role, "id" | "name">[];
}

export interface CreateApiTokenInput {
  name: string;
  /** Owner of the new token. Required when the caller is an env-token actor. */
  user_id?: string;
  role_ids: string[];
  /** RFC3339; omit for non-expiring. */
  expires_at?: string | null;
}

/**
 * `POST /tokens` is the *only* place plaintext is ever returned, and only
 * once. Persist `token` to your secret store immediately.
 *
 * The wire shape is intentionally nested:
 *
 * ```json
 * { "token": "fmt_…", "api_token": { "id": "…", "user_id": "…", … } }
 * ```
 *
 * Token-vs-metadata stays visually obvious in HTTP traces and audit logs.
 * Earlier revisions of this type extended `ApiTokenSummary` directly and
 * silently produced `undefined` ids on the SDK side; do not collapse it
 * back to a flat shape.
 */
export interface CreateApiTokenResponse {
  token: string;
  api_token: ApiTokenSummary;
}
