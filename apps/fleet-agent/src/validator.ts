/**
 * Client-side sanity check run before applying a config. Intentionally the
 * same logic as the server-side validator but duplicated here so that an
 * agent can refuse to apply a config even if the manager was somehow
 * bypassed. A future iteration can replace both with `alloy fmt --check`.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAlloyRendered(contents: string): ValidationResult {
  const errors: string[] = [];
  if (contents.trim().length === 0) {
    errors.push("rendered config is empty");
    return { valid: false, errors };
  }

  let depth = 0;
  let inString = false;
  let inLineComment = false;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    const next = contents[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) {
        errors.push(`unbalanced '}' at offset ${i}`);
        return { valid: false, errors };
      }
    }
  }
  if (depth !== 0) errors.push(`unbalanced braces (depth=${depth})`);
  if (inString) errors.push("unterminated string literal");
  return { valid: errors.length === 0, errors };
}
