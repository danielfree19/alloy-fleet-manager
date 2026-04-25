import { z } from "zod";

export const LabelsSchema = z.record(z.string(), z.string());

export const CollectorStatusSchema = z.enum([
  "unknown",
  "healthy",
  "degraded",
  "unreachable",
]);

export const RegisterRequestSchema = z.object({
  hostname: z.string().min(1),
  ip: z.string().ip().optional().nullable(),
  environment: z.string().min(1),
  labels: LabelsSchema.default({}),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const CreateConfigRequestSchema = z.object({
  name: z.string().min(1).max(200),
  template: z.string().min(1),
});
export type CreateConfigRequest = z.infer<typeof CreateConfigRequestSchema>;

export const CreateConfigVersionRequestSchema = z.object({
  template: z.string().min(1).optional(),
});
export type CreateConfigVersionRequest = z.infer<
  typeof CreateConfigVersionRequestSchema
>;

export const ValidateConfigRequestSchema = z.object({
  template: z.string().min(1),
});
export type ValidateConfigRequest = z.infer<typeof ValidateConfigRequestSchema>;

// Assignment: either target a collector_id directly, or select by labels.
export const AssignmentRequestSchema = z
  .object({
    config_version_id: z.string().uuid(),
    collector_id: z.string().uuid().optional(),
    label_selector: LabelsSchema.optional(),
  })
  .refine(
    (v) => Boolean(v.collector_id) !== Boolean(v.label_selector),
    "Provide exactly one of collector_id or label_selector",
  );
export type AssignmentRequest = z.infer<typeof AssignmentRequestSchema>;

export const HeartbeatRequestSchema = z.object({
  status: CollectorStatusSchema.default("healthy"),
  message: z.string().max(2000).optional().nullable(),
  reported_version: z.string().uuid().optional().nullable(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const RolloutEventRequestSchema = z.object({
  config_version_id: z.string().uuid(),
  status: z.enum(["pending", "success", "failed"]),
  message: z.string().max(2000).optional().nullable(),
});
export type RolloutEventRequest = z.infer<typeof RolloutEventRequestSchema>;

// ---------------------------------------------------------------------------
// Pipeline admin schemas (remotecfg primary path)
// ---------------------------------------------------------------------------

const PipelineNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "name must be alphanumeric + _ . -");

export const CreatePipelineRequestSchema = z.object({
  name: PipelineNameSchema,
  selector: LabelsSchema.default({}),
  content: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type CreatePipelineRequest = z.infer<typeof CreatePipelineRequestSchema>;

export const UpdatePipelineRequestSchema = z
  .object({
    selector: LabelsSchema.optional(),
    content: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.selector !== undefined || v.content !== undefined || v.enabled !== undefined,
    "provide at least one of selector, content, enabled",
  );
export type UpdatePipelineRequest = z.infer<typeof UpdatePipelineRequestSchema>;
