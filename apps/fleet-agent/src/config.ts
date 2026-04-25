import { loadDotenvFromRepoRoot } from "@fleet/shared";
import { hostname as osHostname } from "node:os";
import { z } from "zod";

loadDotenvFromRepoRoot(import.meta.url);

const LabelsEnv = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return {};
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("AGENT_LABELS must be a JSON object of string values");
      }
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = String(val);
      }
      return out;
    } catch (e) {
      throw new Error(`Invalid AGENT_LABELS: ${(e as Error).message}`);
    }
  });

const Env = z.object({
  FLEET_MANAGER_URL: z.string().url(),
  REGISTRATION_TOKEN_AGENT: z.string().min(8),
  AGENT_HOSTNAME: z.string().optional(),
  AGENT_ENVIRONMENT: z.string().default("dev"),
  AGENT_LABELS: LabelsEnv,
  ALLOY_CONFIG_PATH: z.string().default("/etc/alloy/config.alloy"),
  ALLOY_RELOAD_URL: z.string().url().default("http://localhost:12345/-/reload"),
  AGENT_STATE_PATH: z.string().default("/var/lib/alloy-fleet-agent/state.json"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.string().default("development"),
});

export interface AgentConfig {
  fleetManagerUrl: string;
  registrationToken: string;
  hostname: string;
  environment: string;
  labels: Record<string, string>;
  alloyConfigPath: string;
  alloyReloadUrl: string;
  statePath: string;
  pollIntervalMs: number;
  logLevel: string;
  dev: boolean;
}

export function loadAgentConfig(): AgentConfig {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Invalid agent environment:\n${msg}`);
  }
  const d = parsed.data;
  return {
    fleetManagerUrl: d.FLEET_MANAGER_URL.replace(/\/+$/, ""),
    registrationToken: d.REGISTRATION_TOKEN_AGENT,
    hostname: d.AGENT_HOSTNAME || osHostname(),
    environment: d.AGENT_ENVIRONMENT,
    labels: d.AGENT_LABELS,
    alloyConfigPath: d.ALLOY_CONFIG_PATH,
    alloyReloadUrl: d.ALLOY_RELOAD_URL,
    statePath: d.AGENT_STATE_PATH,
    pollIntervalMs: d.POLL_INTERVAL_SECONDS * 1000,
    logLevel: d.LOG_LEVEL,
    dev: d.NODE_ENV === "development",
  };
}
