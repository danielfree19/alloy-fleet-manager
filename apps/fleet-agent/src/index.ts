import { pino } from "pino";
import { loadAgentConfig } from "./config.js";
import { readState, writeState, type AgentState } from "./state.js";
import { FleetApi } from "./api.js";
import { reconcileOnce } from "./reconciler.js";

async function main() {
  const config = loadAgentConfig();
  const log = pino({
    level: config.logLevel,
    transport: config.dev
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  });

  log.info(
    {
      fleetManagerUrl: config.fleetManagerUrl,
      hostname: config.hostname,
      environment: config.environment,
      alloyConfigPath: config.alloyConfigPath,
      pollIntervalMs: config.pollIntervalMs,
    },
    "alloy fleet agent starting",
  );

  const api = new FleetApi({ baseUrl: config.fleetManagerUrl });
  let state = await readState(config.statePath);

  // Register on first boot (or when state was wiped).
  if (!state.collector_id || !state.api_key) {
    log.info("no saved collector_id; registering with fleet manager");
    const reg = await api.register(config.registrationToken, {
      hostname: config.hostname,
      environment: config.environment,
      labels: config.labels,
    });
    state = {
      collector_id: reg.collector_id,
      api_key: reg.api_key,
      last_applied_version_id: null,
      last_applied_checksum: null,
    };
    await writeState(config.statePath, state);
    log.info({ collector_id: state.collector_id }, "registered");
  } else {
    log.info({ collector_id: state.collector_id }, "loaded existing registration");
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    shuttingDown = true;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Reconcile loop.
  while (!shuttingDown) {
    try {
      await reconcileOnce({ config, state, api, log });
    } catch (err) {
      log.error({ err: (err as Error).message }, "reconcile iteration threw");
    }
    await sleep(config.pollIntervalMs, () => shuttingDown);
  }

  log.info("agent stopped");
  process.exit(0);
}

function sleep(ms: number, abort: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (abort() || Date.now() >= end) return resolve();
      setTimeout(tick, Math.min(500, end - Date.now()));
    };
    tick();
  });
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", (err as Error).stack ?? err);
  process.exit(1);
});

// Ensure AgentState import is preserved for tooling.
export type { AgentState };
