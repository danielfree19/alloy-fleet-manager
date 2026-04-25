// Shared domain types used by both the Fleet Manager API and the Fleet Agent.
// Keep this module dependency-free (other than zod) so either side can consume it.

export type Labels = Record<string, string>;

export type CollectorStatus = "unknown" | "healthy" | "degraded" | "unreachable";

export interface Collector {
  id: string;
  hostname: string;
  ip: string | null;
  environment: string;
  labels: Labels;
  last_seen: string | null;
  status: CollectorStatus;
  current_config_version: string | null;
  created_at: string;
}

export interface Config {
  id: string;
  name: string;
  template: string;
  created_at: string;
}

export interface ConfigVersion {
  id: string;
  config_id: string;
  version: number;
  rendered_output: string;
  checksum: string;
  created_at: string;
}

export interface Assignment {
  collector_id: string;
  config_version_id: string;
  assigned_at: string;
}

export type RolloutStatus = "pending" | "success" | "failed";

export interface RolloutEvent {
  id: number;
  config_version_id: string;
  collector_id: string;
  status: RolloutStatus;
  message: string | null;
  timestamp: string;
}

// Agent-facing desired config response.
export interface DesiredConfigResponse {
  config_version_id: string;
  version: number;
  rendered_output: string;
  checksum: string;
}

// Registration response returned by POST /collectors/register.
export interface RegisterResponse {
  collector_id: string;
  api_key: string;
}

// ---------------------------------------------------------------------------
// remotecfg / pipelines model (primary path)
// ---------------------------------------------------------------------------

/**
 * A pipeline is a named chunk of Alloy config with a selector. The Fleet
 * Manager assembles the final config served to `remotecfg` by concatenating
 * the current version of every enabled pipeline whose selector is a subset
 * of the collector's local_attributes.
 */
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
  pipeline_id: string;
  version: number;
  content: string;
  hash: string;
  selector: Labels;
  created_at: string;
}

export type RemotecfgStatus = "UNSET" | "APPLIED" | "APPLYING" | "FAILED";

export interface RemotecfgCollector {
  id: string;
  name: string | null;
  local_attributes: Labels;
  last_seen: string;
  last_status: RemotecfgStatus | null;
  last_error: string | null;
  last_hash_served: string | null;
  created_at: string;
  updated_at: string;
}
