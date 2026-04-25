import { Link, useNavigate } from "react-router-dom";
import { AsyncBoundary } from "@/components/Async";
import { useCachedList } from "@/components/CachedAsync";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { listPipelines, updatePipeline } from "@/api/pipelines";
import { invalidateCache } from "@/store/cache";
import { toast } from "@/store/toasts";
import { useHasPermission } from "@/store/auth";
import { formatAttributes, relativeTime, shortHash } from "@/lib/format";
import type { Pipeline } from "@/api/types";

/** Cache key shared between this page and any component that lists pipelines. */
export const PIPELINES_CACHE_KEY = "pipelines.list";

export function Pipelines() {
  // Cached: navigating Pipelines → detail → back keeps the table on
  // screen instead of re-flashing a spinner. The fetch still runs in
  // the background so the data is fresh.
  const state = useCachedList<Pipeline[]>(PIPELINES_CACHE_KEY, listPipelines);
  const navigate = useNavigate();
  const canCreate = useHasPermission("pipelines.create");

  async function toggleEnabled(p: Pipeline) {
    try {
      const next = !p.enabled;
      await updatePipeline(p.id, { enabled: next });
      toast.success(
        next ? `Enabled "${p.name}"` : `Disabled "${p.name}"`,
        next
          ? "Matching collectors will pick it up on their next remotecfg poll."
          : "Will be removed from matching collectors on their next poll.",
      );
      // Drop the cache so the reload pulls fresh data straight from
      // the API rather than briefly showing the pre-toggle row.
      invalidateCache(PIPELINES_CACHE_KEY);
      state.reload();
    } catch (err) {
      toast.error(
        "Toggle failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }

  return (
    <>
      <PageHeader
        title="Pipelines"
        subtitle="Modular Alloy configs assembled into each collector's final config based on label selectors."
        actions={
          <>
            <button className="btn" onClick={state.reload}>
              Refresh
            </button>
            <Link to="/catalog" className="btn">
              Browse catalog
            </Link>
            {canCreate && (
              <button
                className="btn btn-primary"
                onClick={() => navigate("/pipelines/new")}
              >
                + New pipeline
              </button>
            )}
          </>
        }
      />
      <AsyncBoundary state={state}>
        {(data) => <PipelineTable rows={data} onToggle={toggleEnabled} />}
      </AsyncBoundary>
    </>
  );
}

function PipelineTable({
  rows,
  onToggle,
}: {
  rows: Pipeline[];
  onToggle: (p: Pipeline) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-muted">
        No pipelines yet.{" "}
        <Link to="/pipelines/new" className="text-accent hover:underline">
          Create one from scratch
        </Link>{" "}
        or{" "}
        <Link to="/catalog" className="text-accent hover:underline">
          install from the catalog
        </Link>
        .
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg/40 text-xs text-muted uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-3 font-medium">Name</th>
            <th className="text-left px-4 py-3 font-medium">Selector</th>
            <th className="text-left px-4 py-3 font-medium">Version</th>
            <th className="text-left px-4 py-3 font-medium">Hash</th>
            <th className="text-left px-4 py-3 font-medium">Updated</th>
            <th className="text-left px-4 py-3 font-medium">State</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((p) => (
            <tr key={p.id} className="hover:bg-border/30 transition">
              <td className="px-4 py-3">
                <Link
                  to={`/pipelines/${p.id}`}
                  className="font-medium text-text hover:text-accent"
                >
                  {p.name}
                </Link>
              </td>
              <td className="px-4 py-3 mono text-xs text-muted max-w-[280px] truncate">
                {formatAttributes(p.selector)}
              </td>
              <td className="px-4 py-3 text-muted">v{p.current_version}</td>
              <td className="px-4 py-3 mono text-xs text-muted">
                {shortHash(p.current_hash)}
              </td>
              <td className="px-4 py-3 text-muted text-xs">
                {relativeTime(p.updated_at)}
              </td>
              <td className="px-4 py-3">
                {p.enabled ? (
                  <Pill tone="ok">enabled</Pill>
                ) : (
                  <Pill tone="muted">disabled</Pill>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  className="btn text-xs"
                  onClick={() => onToggle(p)}
                  title={p.enabled ? "Disable this pipeline" : "Enable this pipeline"}
                >
                  {p.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
