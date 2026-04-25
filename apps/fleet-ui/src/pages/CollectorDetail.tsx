import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { Code } from "@/components/Code";
import { SelectorEditor } from "@/components/SelectorEditor";
import { assembleForAttributes } from "@/api/pipelines";
import { listCollectors } from "@/api/collectors";
import { relativeTime, shortHash } from "@/lib/format";
import type { Labels, RemotecfgCollector } from "@/api/types";

export function CollectorDetail() {
  const { id = "" } = useParams();
  const decoded = decodeURIComponent(id);
  // We use the list endpoint and filter client-side because the API doesn't
  // expose a per-collector GET for remotecfg_collectors yet. Cheap enough:
  // we already cache it on the listing page and the fleet is small by spec.
  const state = useAsync(listCollectors);
  const collector = useMemo(
    () => state.data?.find((c) => c.id === decoded) ?? null,
    [state.data, decoded],
  );

  return (
    <>
      <PageHeader
        title={decoded}
        subtitle="Collector detail — reported attributes and assembled config preview."
        actions={
          <Link to="/collectors" className="btn">
            ← Back
          </Link>
        }
      />
      <AsyncBoundary state={state}>
        {() =>
          collector ? (
            <CollectorBody collector={collector} />
          ) : (
            <div className="card p-8 text-sm text-muted">
              Collector not found. It may have been unregistered.
            </div>
          )
        }
      </AsyncBoundary>
    </>
  );
}

function CollectorBody({ collector }: { collector: RemotecfgCollector }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetaCard label="Status">
          <StatusPill status={collector.last_status} />
        </MetaCard>
        <MetaCard label="Last seen">
          <span className="text-sm">{relativeTime(collector.last_seen)}</span>
        </MetaCard>
        <MetaCard label="Served hash">
          <span className="mono text-xs">{shortHash(collector.last_hash_served)}</span>
        </MetaCard>
        <MetaCard label="Registered">
          <span className="text-sm">{relativeTime(collector.created_at)}</span>
        </MetaCard>
      </div>

      <section className="card p-5">
        <h2 className="text-sm font-semibold mb-3">Reported attributes</h2>
        <AttributeTable attrs={collector.local_attributes} />
      </section>

      {collector.last_error && (
        <section className="card p-5 border-danger/40">
          <h2 className="text-sm font-semibold text-danger mb-2">Last error</h2>
          <Code>{collector.last_error}</Code>
        </section>
      )}

      <AssembledPreview seed={collector.local_attributes} />
    </div>
  );
}

function MetaCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] text-muted uppercase tracking-wider mb-2">{label}</div>
      {children}
    </div>
  );
}

function AttributeTable({ attrs }: { attrs: Labels }) {
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) {
    return <div className="text-sm text-muted italic">No attributes reported.</div>;
  }
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-border">
        {keys.map((k) => (
          <tr key={k}>
            <td className="py-2 pr-4 mono text-xs text-muted w-48">{k}</td>
            <td className="py-2 mono text-xs">{attrs[k]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: RemotecfgCollector["last_status"] }) {
  if (status === "APPLIED") return <Pill tone="ok">applied</Pill>;
  if (status === "APPLYING") return <Pill tone="warn">applying</Pill>;
  if (status === "FAILED") return <Pill tone="danger">failed</Pill>;
  return <Pill tone="muted">unset</Pill>;
}

/**
 * Asks the backend which pipelines would be served to a hypothetical
 * collector with the edited attributes, and shows the assembled config. By
 * default we seed with the collector's real reported attributes, so the
 * default view shows "what this collector is getting right now."
 */
function AssembledPreview({ seed }: { seed: Labels }) {
  const [attrs, setAttrs] = useState<Labels>(seed);
  const [assembling, setAssembling] = useState(false);
  const [result, setResult] = useState<{
    content: string;
    hash: string;
    pipeline_names: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setAssembling(true);
    setError(null);
    try {
      const r = await assembleForAttributes(attrs);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setAssembling(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <h2 className="text-sm font-semibold">Assembled config preview</h2>
          <p className="text-xs text-muted mt-1">
            Edit the attributes and assemble to preview what the manager would
            serve. Previews never touch collector state.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={run}
          disabled={assembling}
        >
          {assembling ? "Assembling…" : "Assemble"}
        </button>
      </div>
      <SelectorEditor
        value={attrs}
        onChange={setAttrs}
        placeholderKey="env"
        placeholderValue="prod"
      />
      {error && <div className="text-xs text-danger mt-3">{error}</div>}
      {result && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>Matched pipelines:</span>
            {result.pipeline_names.length === 0 ? (
              <Pill tone="warn">none</Pill>
            ) : (
              result.pipeline_names.map((n) => (
                <Pill key={n} tone="accent">
                  {n}
                </Pill>
              ))
            )}
            <span className="mono ml-auto">hash: {shortHash(result.hash)}</span>
          </div>
          <Code>{result.content}</Code>
        </div>
      )}
    </section>
  );
}
