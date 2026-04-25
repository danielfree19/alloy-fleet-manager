/**
 * SSO YAML configuration loader.
 *
 * Loads + validates the YAML file pointed at by `SSO_CONFIG_FILE`.
 * Returns `null` when the file is absent (SSO disabled). Returns the
 * parsed + Zod-validated structure otherwise.
 *
 * Design: this loader is the ONLY thing that touches the filesystem
 * for SSO config. The provider registry consumes its output. Keeping
 * IO at the edge means tests can hand the registry a literal config
 * object without faking a YAML file.
 *
 * Variable interpolation: every string value in the YAML supports
 * `${env:VARNAME}` substitution. Used by operators to keep
 * `client_secret` out of the YAML itself:
 *
 *   client_secret: ${env:KEYCLOAK_CLIENT_SECRET}
 *
 * Unknown env vars resolve to empty strings; the Zod validator then
 * rejects the empty value where it matters (e.g. client_id), so a
 * typo'd env var fails fast at boot rather than silently signing
 * users in with garbage.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { UnsafeIssuerError, assertSafeIssuerUrl } from "./url-guard.js";

/**
 * Wire-level YAML schema. `role_mappings` is an OBJECT (group_value →
 * role_name) for ergonomic authoring; the loader resolves role_name
 * → role_id later (against the live `roles` table) since DB ids are
 * not stable across deployments.
 */
const ProviderYaml = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be a lowercase slug"),
  kind: z.enum(["oidc"]),
  display_name: z.string().min(1),
  issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string()).default(["openid", "email", "profile"]),
  groups_claim: z.string().default("groups"),
  role_mappings: z.record(z.string(), z.string()).default({}),
});

const SsoYaml = z.object({
  providers: z.array(ProviderYaml).default([]),
});

export type SsoYamlConfig = z.infer<typeof SsoYaml>;
export type SsoYamlProvider = z.infer<typeof ProviderYaml>;

const ENV_INTERPOLATION_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_INTERPOLATION_RE, (_, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env);
    }
    return out;
  }
  return value;
}

/**
 * Load + validate an SSO YAML file.
 *
 *   loadSsoYaml(undefined)            -> null  (SSO disabled)
 *   loadSsoYaml("/etc/fleet/sso.yml") -> { providers: [...] }
 *
 * Throws on parse / validation errors so a misconfigured file fails
 * the boot loudly rather than silently breaking sign-in.
 */
export function loadSsoYaml(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SsoYamlConfig | null {
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  // js-yaml's `load` returns `unknown`; we don't trust shape until Zod
  // has had a turn.
  const parsed: unknown = yaml.load(raw);
  if (parsed === null || parsed === undefined) {
    // Treat an empty file as "no providers" rather than an error so
    // operators can stub out SSO temporarily without removing the
    // env var.
    return { providers: [] };
  }
  const interpolated = interpolateEnv(parsed, env);
  const validated = SsoYaml.safeParse(interpolated);
  if (!validated.success) {
    const msg = validated.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid SSO config (${path}):\n${msg}`);
  }
  // Final sanity: provider ids must be unique within the file.
  const seen = new Set<string>();
  for (const p of validated.data.providers) {
    if (seen.has(p.id)) {
      throw new Error(`Invalid SSO config (${path}): duplicate provider id '${p.id}'`);
    }
    seen.add(p.id);
  }
  return validated.data;
}

/**
 * Run the SSRF guard against every YAML provider's `issuer` URL.
 * Separate from `loadSsoYaml` because the guard is async (does a DNS
 * lookup) and the loader is otherwise sync. Boot calls one after the
 * other; a hostile YAML fails the boot loudly.
 */
export async function assertSsoYamlIsSafe(yamlConfig: SsoYamlConfig): Promise<void> {
  for (const p of yamlConfig.providers) {
    try {
      await assertSafeIssuerUrl(p.issuer);
    } catch (err) {
      if (err instanceof UnsafeIssuerError) {
        throw new Error(
          `Invalid SSO config: provider '${p.id}' issuer rejected by SSRF guard (${err.code}): ${err.message}`,
        );
      }
      throw err;
    }
  }
}
