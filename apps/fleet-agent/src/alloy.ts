import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { request } from "undici";
import type { Logger } from "pino";

/**
 * Atomically write the Alloy config:
 *   1. Snapshot existing file to `<path>.prev` (if present).
 *   2. Write new contents to `<path>.tmp`, fsync, rename over `<path>`.
 * Returns the path of the backup (or null if no previous file existed), so
 * the caller can restore it if `reloadAlloy` fails.
 */
export async function writeAlloyConfig(
  path: string,
  contents: string,
  log: Logger,
): Promise<string | null> {
  await fs.mkdir(dirname(path), { recursive: true });

  let backupPath: string | null = null;
  try {
    await fs.access(path);
    backupPath = `${path}.prev`;
    await fs.copyFile(path, backupPath);
    log.debug({ backupPath }, "backed up existing alloy config");
  } catch {
    // file didn't exist; nothing to back up
  }

  const tmp = `${path}.tmp`;
  const fh = await fs.open(tmp, "w", 0o644);
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
  log.info({ path, bytes: contents.length }, "wrote alloy config");
  return backupPath;
}

export async function restoreBackup(path: string, backupPath: string, log: Logger): Promise<void> {
  await fs.copyFile(backupPath, path);
  log.warn({ path, backupPath }, "restored previous alloy config after failed reload");
}

export async function reloadAlloy(reloadUrl: string, log: Logger): Promise<void> {
  const res = await request(reloadUrl, {
    method: "POST",
    bodyTimeout: 10_000,
    headersTimeout: 10_000,
  });
  const body = await res.body.text();
  if (res.statusCode >= 200 && res.statusCode < 300) {
    log.info({ status: res.statusCode }, "alloy reload succeeded");
    return;
  }
  throw new Error(`alloy reload failed ${res.statusCode}: ${body}`);
}
