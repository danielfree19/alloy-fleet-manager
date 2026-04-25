import { apiFetch } from "./client";
import type { RemotecfgCollector } from "./types";

export async function listCollectors(): Promise<RemotecfgCollector[]> {
  const r = await apiFetch<{ collectors: RemotecfgCollector[] }>("/remotecfg/collectors");
  return r.collectors;
}
