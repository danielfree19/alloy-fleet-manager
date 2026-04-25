import type { Logger } from "pino";
import type { AgentConfig } from "./config.js";
import type { AgentState } from "./state.js";
import { writeState } from "./state.js";
import { FleetApi, FleetApiError } from "./api.js";
import { writeAlloyConfig, reloadAlloy, restoreBackup } from "./alloy.js";
import { validateAlloyRendered } from "./validator.js";

export interface ReconcilerDeps {
  config: AgentConfig;
  state: AgentState; // mutated in place on successful apply
  api: FleetApi;
  log: Logger;
}

/**
 * Single reconcile pass. Caller drives the loop.
 *
 * Failure handling matches the handoff spec:
 *   - invalid rendered config    -> reject + POST rollout_events failed
 *   - alloy /-/reload fails      -> restore previous file + POST failed
 *   - fleet-manager unreachable  -> keep current config, log, return
 */
export async function reconcileOnce({ config, state, api, log }: ReconcilerDeps): Promise<void> {
  if (!state.collector_id || !state.api_key) {
    throw new Error("reconcileOnce called before agent registration");
  }

  // 1. Heartbeat first — so even a failed reconcile leaves a liveness signal.
  try {
    await api.heartbeat(state.collector_id, state.api_key, {
      status: "healthy",
      reported_version: state.last_applied_version_id ?? null,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "heartbeat failed");
  }

  // 2. Fetch desired config.
  let desired;
  try {
    desired = await api.getDesiredConfig(state.collector_id, state.api_key);
  } catch (err) {
    if (err instanceof FleetApiError) {
      log.warn(
        { status: err.status, body: err.body },
        "fetch desired config failed (keeping current config)",
      );
    } else {
      log.warn(
        { err: (err as Error).message },
        "fetch desired config errored (keeping current config)",
      );
    }
    return;
  }

  if (!desired) {
    log.debug("no assignment for this collector yet");
    return;
  }

  // 3. Short-circuit if nothing changed.
  if (
    desired.config_version_id === state.last_applied_version_id &&
    desired.checksum === state.last_applied_checksum
  ) {
    log.debug({ version: desired.version }, "config unchanged");
    return;
  }

  log.info(
    {
      from: state.last_applied_version_id,
      to: desired.config_version_id,
      version: desired.version,
    },
    "new config version detected",
  );

  // 4. Local validation before touching disk.
  const validation = validateAlloyRendered(desired.rendered_output);
  if (!validation.valid) {
    log.error({ errors: validation.errors }, "rendered config failed local validation");
    await reportFailure(
      api,
      state.collector_id,
      state.api_key,
      desired.config_version_id,
      `local validation failed: ${validation.errors.join("; ")}`,
      log,
    );
    return;
  }

  // 5. Atomic write + reload, with revert on failure.
  let backupPath: string | null = null;
  try {
    backupPath = await writeAlloyConfig(config.alloyConfigPath, desired.rendered_output, log);
  } catch (err) {
    log.error({ err: (err as Error).message }, "failed to write alloy config");
    await reportFailure(
      api,
      state.collector_id,
      state.api_key,
      desired.config_version_id,
      `write failed: ${(err as Error).message}`,
      log,
    );
    return;
  }

  try {
    await reloadAlloy(config.alloyReloadUrl, log);
  } catch (err) {
    log.error({ err: (err as Error).message }, "alloy reload failed, attempting revert");
    if (backupPath) {
      try {
        await restoreBackup(config.alloyConfigPath, backupPath, log);
      } catch (rerr) {
        log.error({ err: (rerr as Error).message }, "revert itself failed");
      }
    }
    await reportFailure(
      api,
      state.collector_id,
      state.api_key,
      desired.config_version_id,
      `reload failed: ${(err as Error).message}`,
      log,
    );
    return;
  }

  // 6. Success: persist state and report success.
  state.last_applied_version_id = desired.config_version_id;
  state.last_applied_checksum = desired.checksum;
  await writeState(config.statePath, state);

  try {
    await api.rolloutEvent(state.collector_id, state.api_key, {
      config_version_id: desired.config_version_id,
      status: "success",
      message: `applied version ${desired.version}`,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "failed to report success rollout event");
  }
}

async function reportFailure(
  api: FleetApi,
  collectorId: string,
  apiKey: string,
  configVersionId: string,
  message: string,
  log: Logger,
) {
  try {
    await api.rolloutEvent(collectorId, apiKey, {
      config_version_id: configVersionId,
      status: "failed",
      message,
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "failed to report failure rollout event");
  }
}
