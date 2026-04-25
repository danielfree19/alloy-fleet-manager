import { Link } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { listCollectors } from "@/api/collectors";
import { formatAttributes, relativeTime, shortHash } from "@/lib/format";
import type { RemotecfgCollector } from "@/api/types";

export function Collectors() {
  const state = useAsync(listCollectors);

  return (
    <>
      <PageHeader
        title="Collectors"
        subtitle="Every Alloy instance that has called home via remotecfg."
        actions={
          <button className="btn" onClick={state.reload}>
            Refresh
          </button>
        }
      />
      <AsyncBoundary state={state}>
        {(data) => <CollectorTable rows={data} />}
      </AsyncBoundary>
    </>
  );
}

function CollectorTable({ rows }: { rows: RemotecfgCollector[] }) {
  if (rows.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-muted text-sm">
          No collectors yet. Start an Alloy instance with the fleet bootstrap
          config and it will appear here.
        </div>
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg/40 text-xs text-muted uppercase tracking-wider">
          <tr>
            <th className="text-left px-4 py-3 font-medium">ID</th>
            <th className="text-left px-4 py-3 font-medium">Status</th>
            <th className="text-left px-4 py-3 font-medium">Attributes</th>
            <th className="text-left px-4 py-3 font-medium">Last seen</th>
            <th className="text-left px-4 py-3 font-medium">Served hash</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((c) => (
            <tr key={c.id} className="hover:bg-border/30 transition">
              <td className="px-4 py-3">
                <Link
                  to={`/collectors/${encodeURIComponent(c.id)}`}
                  className="font-medium text-text hover:text-accent"
                >
                  {c.id}
                </Link>
                {c.name && (
                  <div className="text-xs text-muted mt-0.5">{c.name}</div>
                )}
              </td>
              <td className="px-4 py-3">
                <StatusPill status={c.last_status} />
                {c.last_error && (
                  <div
                    className="text-[11px] text-danger mt-1 max-w-[200px] truncate"
                    title={c.last_error}
                  >
                    {c.last_error}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 mono text-xs text-muted max-w-[280px] truncate">
                {formatAttributes(c.local_attributes)}
              </td>
              <td className="px-4 py-3 text-muted text-xs">
                {relativeTime(c.last_seen)}
              </td>
              <td className="px-4 py-3 mono text-xs text-muted">
                {shortHash(c.last_hash_served)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: RemotecfgCollector["last_status"] }) {
  if (status === "APPLIED") return <Pill tone="ok">applied</Pill>;
  if (status === "APPLYING") return <Pill tone="warn">applying</Pill>;
  if (status === "FAILED") return <Pill tone="danger">failed</Pill>;
  return <Pill tone="muted">unset</Pill>;
}
