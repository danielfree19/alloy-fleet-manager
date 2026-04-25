/**
 * Zod schema for the template catalog. Shared between the local file
 * loader and the optional remote-URL loader so both paths validate
 * identically.
 *
 * The schema is deliberately permissive about `tags` / `default_selector`
 * but strict about required fields, so a bad template in a remote
 * catalog can't crash the manager — we reject the whole payload with a
 * readable message instead.
 */

import { z } from "zod";

export const CatalogCategorySchema = z.enum([
  "metrics",
  "logs",
  "traces",
  "sinks",
  "infra",
]);

export type CatalogCategory = z.infer<typeof CatalogCategorySchema>;

export const CatalogTemplateSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase slug (a-z, 0-9, hyphen)"),
  name: z.string().min(1),
  description: z.string().min(1),
  category: CatalogCategorySchema,
  tags: z.array(z.string()).default([]),
  default_selector: z.record(z.string()).default({}),
  suggested_name: z.string().optional(),
  docs_url: z.string().url().optional(),
  requires: z.array(z.string()).default([]),
  content: z.string().min(1),
});

export type CatalogTemplate = z.infer<typeof CatalogTemplateSchema>;

export const CatalogFileSchema = z
  .object({
    version: z.literal(1),
    templates: z.array(CatalogTemplateSchema),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    for (const [i, t] of val.templates.entries()) {
      if (seen.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["templates", i, "id"],
          message: `duplicate template id: ${t.id}`,
        });
      }
      seen.add(t.id);
    }
  });

export type CatalogFile = z.infer<typeof CatalogFileSchema>;
