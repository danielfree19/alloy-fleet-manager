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

  // Identity / session config (optional). All have safe defaults so a
  // pre-existing deployment that doesn't set them keeps running.

  /**
   * Secret used to sign session cookies. We don't strictly NEED to
   * sign them since they're random opaque ids and we look them up
   * server-side, but a signed cookie lets us reject obviously-invalid
   * values without a DB hit. Auto-derived from ADMIN_TOKEN if unset.
   *
   * The `.transform` step is load-bearing: docker-compose's
   * `${SESSION_COOKIE_SECRET:-}` produces a literal empty string when the
   * env var is unset upstream, and `@fastify/cookie` with `secret: ""`
   * silently registers WITHOUT a signer. The first `signCookie()` call
   * (i.e. login) then 500s with `signer.sign is not a function`. Coerce
   * empty here so every downstream consumer sees `undefined` and hits
   * the ADMIN_TOKEN-derived fallback.
   */
  SESSION_COOKIE_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v)),

  /**
   * Bootstrap admin: when the `users` table is empty at startup we
   * create exactly one admin user with these credentials so the
   * operator can sign in to the UI. Optional; if unset the bootstrap
   * is skipped and the operator must use ADMIN_TOKEN (env break-glass)
   * to seed users via the API.
   *
   * After first boot these are no-ops (we only seed when count = 0).
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),

  /**
   * Path to a YAML file declaring SSO identity providers (Phase 2).
   * Optional; SSO is fully off when unset and the manager behaves
   * exactly as in Phase 1.
   *
   * Same empty-string trap as `SESSION_COOKIE_SECRET`: docker-compose's
   * `${SSO_CONFIG_FILE:-}` produces a literal "" when the env var is
   * unset upstream, and `""` is a valid filename to `fs.readFileSync`
   * which would 500 the boot. Coerce empty here so loaders see exactly
   * `undefined` and short-circuit.
   */
  SSO_CONFIG_FILE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v)),
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
