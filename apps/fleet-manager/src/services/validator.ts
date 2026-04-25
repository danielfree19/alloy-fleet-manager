/**
 * Validator for Alloy config syntax.
 *
 * Two layers:
 *   1. `validateAlloyTemplate` — fast, in-process brace/quote sanity check.
 *      Cheap, always runs, catches obvious mistakes (unterminated strings,
 *      unbalanced braces). Used as a guard in the write path so a single
 *      typo can never take down the fleet.
 *   2. `validateAlloyTemplateStrict` — shells out to the `alloy fmt`
 *      binary (if present on PATH) for a real parser-backed check. This
 *      catches invalid blocks, unknown components, and expression errors
 *      that the brace check can't. If the binary is missing it falls
 *      back silently to the cheap check.
 *
 * We deliberately DON'T run `alloy run --dry-run` because that would try
 * to instantiate components (open network sockets, read files, etc). We
 * only want a lexer/parser sweep.
 */

import { spawn, spawnSync } from "node:child_process";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Which engine produced the verdict. */
  engine?: "builtin" | "alloy-fmt";
}

export function validateAlloyTemplate(template: string): ValidationResult {
  const errors: string[] = [];

  if (template.trim().length === 0) {
    errors.push("template is empty");
    return { valid: false, errors };
  }

  // Balanced braces check, ignoring content inside double-quoted strings
  // and // line comments.
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    const next = template[i + 1];

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
  if (depth !== 0) {
    errors.push(`unbalanced braces (depth=${depth} at EOF)`);
  }
  if (inString) {
    errors.push("unterminated string literal");
  }

  return { valid: errors.length === 0, errors, engine: "builtin" };
}

// ---------------------------------------------------------------------------
// Strict validation via `alloy fmt`
// ---------------------------------------------------------------------------

/**
 * Tri-state cache for whether the `alloy` CLI is usable. We probe once at
 * first call and then cache, because spawning a missing binary on every
 * pipeline write would be wasteful. Set to `null` before the probe runs.
 */
let alloyBinaryAvailable: boolean | null = null;

/** Override for tests or for operators who install alloy outside PATH. */
function alloyBinaryPath(): string {
  return process.env["FLEET_ALLOY_BIN"] ?? "alloy";
}

function probeAlloyBinary(): boolean {
  if (alloyBinaryAvailable !== null) return alloyBinaryAvailable;
  try {
    const probe = spawnSync(alloyBinaryPath(), ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    alloyBinaryAvailable = probe.status === 0;
    if (!alloyBinaryAvailable) {
      console.warn(
        `[validator] alloy binary returned non-zero status ${probe.status} on --version; falling back to builtin check`,
      );
    }
  } catch (err) {
    alloyBinaryAvailable = false;
    console.warn(
      `[validator] alloy binary not found on PATH (${alloyBinaryPath()}): ${err instanceof Error ? err.message : err}. Strict validation disabled; using builtin check.`,
    );
  }
  return alloyBinaryAvailable;
}

/** Log once at startup so operators know whether strict validation is on. */
export function reportValidatorCapability(): void {
  const ok = probeAlloyBinary();
  if (ok) {
    console.info(`[validator] strict validation enabled via '${alloyBinaryPath()} fmt'`);
  } else {
    console.warn(
      `[validator] strict validation DISABLED — '${alloyBinaryPath()}' not found. ` +
        "Pipeline writes will still run the builtin brace/quote check.",
    );
  }
}

/**
 * Run `alloy fmt -` on the provided content. Succeeds iff the parser
 * accepts it. The formatter's stdout (the pretty-printed copy) is
 * discarded — we only care about the exit code and stderr.
 *
 * If the binary is unavailable, transparently falls back to the builtin
 * check. Callers don't need to branch.
 */
export async function validateAlloyTemplateStrict(
  template: string,
): Promise<ValidationResult> {
  const cheap = validateAlloyTemplate(template);
  if (!cheap.valid) return cheap; // obvious syntax errors don't need alloy.

  if (!probeAlloyBinary()) {
    return { ...cheap, engine: "builtin" };
  }

  return await new Promise<ValidationResult>((resolve) => {
    const proc = spawn(alloyBinaryPath(), ["fmt"], {
      stdio: ["pipe", "pipe", "pipe"],
      // Guard against hangs — parsing ~100KB should take milliseconds.
      // A 10s ceiling is 100x headroom.
      timeout: 10_000,
    });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.stdout.on("data", () => {
      /* discard formatted output */
    });
    proc.on("error", (err) => {
      // Likely ENOENT despite the earlier probe (race / binary replaced).
      // Keep going with the builtin result — we've already got `cheap`.
      alloyBinaryAvailable = false;
      resolve({
        ...cheap,
        engine: "builtin",
        errors: [...cheap.errors, `alloy fmt unavailable: ${err.message}`],
      });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ valid: true, errors: [], engine: "alloy-fmt" });
      } else {
        resolve({
          valid: false,
          errors: stderr
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
          engine: "alloy-fmt",
        });
      }
    });
    proc.stdin.end(template);
  });
}
