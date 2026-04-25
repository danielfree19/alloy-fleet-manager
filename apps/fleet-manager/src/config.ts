import { loadDotenvFromRepoRoot } from "@fleet/shared";
import { z } from "zod";

// Load the root .env regardless of which workspace is the cwd. Must run
// before any env-var access below (Env.safeParse reads process.env).
loadDotenvFromRepoRoot(import.meta.url);

const Env = z.object({
  FLEET_MANAGER_HOST: z.string().default("0.0.0.0"),
  FLEET_MANAGER_PORT: z.coerce.number().int().positive().default(9090),
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(8),
  REGISTRATION_TOKEN: z.string().min(8),
  AGENT_BEARER_TOKEN: z.string().min(8),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.string().default("development"),
});

export type AppConfig = z.infer<typeof Env>;

export function loadConfig(): AppConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  return parsed.data;
}
