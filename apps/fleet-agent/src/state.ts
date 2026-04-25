import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Local state persisted between agent runs. Intentionally JSON so an operator
 * can inspect/edit it during incident response.
 */
export interface AgentState {
  collector_id: string | null;
  api_key: string | null;
  last_applied_version_id: string | null;
  last_applied_checksum: string | null;
}

const EMPTY_STATE: AgentState = {
  collector_id: null,
  api_key: null,
  last_applied_version_id: null,
  last_applied_checksum: null,
};

export async function readState(path: string): Promise<AgentState> {
  try {
    const buf = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(buf) as Partial<AgentState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...EMPTY_STATE };
    throw err;
  }
}

export async function writeState(path: string, state: AgentState): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
}
