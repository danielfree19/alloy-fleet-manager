import { Link, useNavigate } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { listPipelines, updatePipeline } from "@/api/pipelines";
import { formatAttributes, relativeTime, shortHash } from "@/lib/format";
import type { Pipeline } from "@/api/types";

export function Pipelines() {
  const state = useAsync(listPipelines);
  const navigate = useNavigate();

  async function toggleEnabled(p: Pipeline) {
    await updatePipeline(p.id, { enabled: !p.enabled });
    state.reload();
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
            <button
              className="btn btn-primary"
              onClick={() => navigate("/pipelines/new")}
            >
              + New pipeline
            </button>
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
