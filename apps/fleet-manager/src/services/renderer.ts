import { createHash } from "node:crypto";
import type { Labels } from "@fleet/shared";

/**
 * MVP renderer: performs simple `{{label.key}}` substitution against a
 * collector's labels. The rendered output is persisted on the config_version
 * row so it is NEVER re-rendered on read (configs are immutable + versioned,
 * per the design principles in the handoff doc).
 *
 * Intentionally tiny and swappable: replace this file to plug in a real
 * template engine (e.g. Handlebars, Alloy "river" modules) without touching
 * callers.
 */
export function renderTemplate(template: string, labels: Labels): string {
  return template.replace(/\{\{\s*label\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, key) => {
    return labels[key] ?? "";
  });
}

export function checksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
