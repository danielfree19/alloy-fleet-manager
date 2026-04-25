/**
 * Shared API response shapes. These mirror what the Fleet Manager returns,
 * but we keep them UI-local so the UI package has no runtime dependency on
 * the server package (Vite doesn't need to resolve workspace TS sources).
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
  // Pipelines (Phase 0)
  | "pipeline.create"
  | "pipeline.update"
  | "pipeline.delete"
  // Identity / RBAC (Phase 1)
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
  /**
   * Server returns this as plain text; we keep it loose-typed (string)
   * for forward compatibility with new kinds added on the backend that
   * the UI hasn't been updated for yet.
   */
  target_kind: AuditTargetKind | string;
  target_id: string | null;
  target_name: string | null;
  metadata: Record<string, unknown>;
  // Structured actor columns added with the identity migration.
  // Older pre-identity rows will have these set to null.
  actor_kind?: "env_token" | "user" | "api_token" | null;
  actor_user_id?: string | null;
  actor_email?: string | null;
  actor_token_id?: string | null;
}

export interface ListAuditFilter {
  target_kind?: string;
  target_id?: string;
  action?: AuditAction;
  /**
   * Comma-separated list of actions for OR filtering. Mirrors the
   * server's `actions=` query param. Used by the SSO Activity page
   * which needs to pull both `auth.sso.login` and `auth.sso.rejected`
   * events in a single call.
   */
  actions?: string;
  actor?: string;
  before?: string;
  limit?: number;
}

export type CatalogCategory = "metrics" | "logs" | "traces" | "sinks" | "infra";

/** Lightweight catalog entry returned by GET /catalog (no `content`). */
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

/** Full catalog entry returned by GET /catalog/:id. */
export interface CatalogTemplate extends CatalogTemplateSummary {
  content: string;
}

export interface CatalogListResponse {
  sources: string[];
  templates: CatalogTemplateSummary[];
}

// ---------------------------------------------------------------------------
// Identity / RBAC / API tokens
// ---------------------------------------------------------------------------

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
  | "sso.write";

export interface Role {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  created_at: string;
  permissions: Permission[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  has_password: boolean;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  disabled: boolean;
  created_at: string;
  updated_at: string;
  roles: { id: string; name: string }[];
}

export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  roles: { id: string; name: string }[];
}

/** Response shape for POST /tokens — `token` is the plaintext, shown ONCE. */
export interface CreateApiTokenResponse {
  token: string;
  api_token: ApiToken;
}
