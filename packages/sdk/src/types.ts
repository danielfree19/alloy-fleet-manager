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

export type AuditAction = "pipeline.create" | "pipeline.update" | "pipeline.delete";

export interface AuditEvent {
  id: string;
  created_at: string;
  actor: string;
  action: AuditAction;
  target_kind: string;
  target_id: string | null;
  target_name: string | null;
  metadata: Record<string, unknown>;
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
