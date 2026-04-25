import { apiFetch } from "./client";
import type {
  AssembledConfig,
  CreatePipelineInput,
  Labels,
  Pipeline,
  PipelineDetail,
  UpdatePipelineInput,
} from "./types";

export async function listPipelines(): Promise<Pipeline[]> {
  const r = await apiFetch<{ pipelines: Pipeline[] }>("/pipelines");
  return r.pipelines;
}

export async function getPipeline(id: string): Promise<PipelineDetail> {
  return apiFetch<PipelineDetail>(`/pipelines/${id}`);
}

export async function createPipeline(input: CreatePipelineInput): Promise<Pipeline> {
  return apiFetch<Pipeline>("/pipelines", { method: "POST", body: input });
}

export async function updatePipeline(
  id: string,
  input: UpdatePipelineInput,
): Promise<Pipeline> {
  return apiFetch<Pipeline>(`/pipelines/${id}`, { method: "PATCH", body: input });
}

export async function deletePipeline(id: string): Promise<void> {
  await apiFetch<void>(`/pipelines/${id}`, { method: "DELETE" });
}

/**
 * Admin preview: ask the manager to assemble a config for a hypothetical
 * collector with the given attributes. Used by the selector builder to show
 * "which pipelines would match a collector with these labels?" without
 * requiring a real Alloy instance.
 */
export async function assembleForAttributes(attributes: Labels): Promise<AssembledConfig> {
  return apiFetch<AssembledConfig>("/pipelines/assemble", {
    method: "POST",
    body: { attributes },
  });
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  engine?: "builtin" | "alloy-fmt";
}

/**
 * Preflight syntax check. Hits the same validator the write path uses
 * but with no side effects, so operators can sanity-check a config
 * before hitting Save.
 */
export async function validatePipelineContent(content: string): Promise<ValidateResult> {
  return apiFetch<ValidateResult>("/pipelines/validate", {
    method: "POST",
    body: { content },
  });
}
