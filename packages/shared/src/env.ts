import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

/**
 * Loads the repo-root `.env` regardless of which workspace is the cwd.
 *
 * npm workspaces run scripts with cwd = the workspace directory, so a plain
 * `import "dotenv/config"` looks for `.env` in `apps/<name>/` and finds
 * nothing. We walk up from the calling file until we find a `.env`.
 *
 * Pass `import.meta.url` of the calling module as `importMetaUrl`.
 */
export function loadDotenvFromRepoRoot(importMetaUrl: string): void {
  const startDir = dirname(fileURLToPath(importMetaUrl));
  let dir = startDir;
  // Climb at most 8 levels; the repo root is 3-5 levels up in practice.
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No .env found — fall back to default (pure process.env). This is fine
  // in container deployments where env vars come from the orchestrator.
  dotenvConfig();
}
