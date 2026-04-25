import { Link } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { listPipelines } from "@/api/pipelines";
import { listCollectors } from "@/api/collectors";
import { relativeTime, shortHash } from "@/lib/format";
import type { Pipeline, RemotecfgCollector } from "@/api/types";

export function Overview() {
  const pipes = useAsync(listPipelines);
  const collectors = useAsync(listCollectors);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Live view of the fleet. Everything here refreshes on page load."
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Pipelines"
          value={pipes.data?.length ?? "…"}
          sub={enabledSubtitle(pipes.data)}
          href="/pipelines"
        />
        <StatCard
          label="Collectors"
          value={collectors.data?.length ?? "…"}
          sub={healthySubtitle(collectors.data)}
          href="/collectors"
        />
        <StatCard
          label="Last check-in"
          value={latestSeen(collectors.data)}
          sub="Across all collectors"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="card p-5">
          <SectionTitle
            title="Recent collectors"
            link={{ to: "/collectors", label: "View all" }}
          />
          <AsyncBoundary state={collectors}>
            {(data) => (
              <RecentCollectors items={data.slice(0, 6)} />
            )}
          </AsyncBoundary>
        </section>

        <section className="card p-5">
          <SectionTitle
            title="Pipelines"
            link={{ to: "/pipelines", label: "Manage" }}
          />
          <AsyncBoundary state={pipes}>
            {(data) => <PipelineList items={data} />}
          </AsyncBoundary>
        </section>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <div className="card p-5 h-full transition hover:border-accent/40">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div className="text-3xl font-semibold mt-2">{value}</div>
      {sub && <div className="text-xs text-muted mt-2">{sub}</div>}
    </div>
  );
  return href ? <Link to={href}>{inner}</Link> : inner;
}

function SectionTitle({
  title,
  link,
}: {
  title: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {link && (
        <Link to={link.to} className="text-xs text-accent hover:underline">
          {link.label} →
        </Link>
      )}
    </div>
  );
}

function RecentCollectors({ items }: { items: RemotecfgCollector[] }) {
  if (items.length === 0) {
    return <div className="text-sm text-muted italic">No collectors yet.</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((c) => (
        <li key={c.id} className="py-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={`/collectors/${encodeURIComponent(c.id)}`}
              className="font-medium text-text hover:text-accent truncate block"
            >
              {c.id}
            </Link>
            <div className="text-xs text-muted mono truncate">
              {shortHash(c.last_hash_served)} · {relativeTime(c.last_seen)}
            </div>
          </div>
          <StatusPill status={c.last_status} />
        </li>
      ))}
    </ul>
  );
}

function PipelineList({ items }: { items: Pipeline[] }) {
  if (items.length === 0) {
    return <div className="text-sm text-muted italic">No pipelines defined.</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((p) => (
        <li key={p.id} className="py-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={`/pipelines/${p.id}`}
              className="font-medium text-text hover:text-accent truncate block"
            >
              {p.name}
            </Link>
            <div className="text-xs text-muted truncate">
              v{p.current_version} · {Object.keys(p.selector).length} labels
            </div>
          </div>
          {p.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="muted">disabled</Pill>}
        </li>
      ))}
    </ul>
  );
}

function StatusPill({ status }: { status: RemotecfgCollector["last_status"] }) {
  if (status === "APPLIED") return <Pill tone="ok">applied</Pill>;
  if (status === "APPLYING") return <Pill tone="warn">applying</Pill>;
  if (status === "FAILED") return <Pill tone="danger">failed</Pill>;
  return <Pill tone="muted">unset</Pill>;
}

function enabledSubtitle(pipes: Pipeline[] | null): string {
  if (!pipes) return "";
  const enabled = pipes.filter((p) => p.enabled).length;
  return `${enabled} enabled · ${pipes.length - enabled} disabled`;
}

function healthySubtitle(cs: RemotecfgCollector[] | null): string {
  if (!cs) return "";
  const applied = cs.filter((c) => c.last_status === "APPLIED").length;
  const failed = cs.filter((c) => c.last_status === "FAILED").length;
  return `${applied} applied · ${failed} failed`;
}

function latestSeen(cs: RemotecfgCollector[] | null): string {
  if (!cs || cs.length === 0) return "—";
  const ts = cs
    .map((c) => (c.last_seen ? new Date(c.last_seen).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  if (ts === 0) return "never";
  return relativeTime(new Date(ts).toISOString());
}
