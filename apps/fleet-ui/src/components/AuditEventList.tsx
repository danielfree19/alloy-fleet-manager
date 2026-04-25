import { Link } from "react-router-dom";
import { Pill } from "./Pill";
import { relativeTime } from "@/lib/format";
import type { AuditEvent } from "@/api/types";

/**
 * Shared audit event renderer. Used as the whole body of the /audit page
 * and as a section on the pipeline edit page (filtered by target_id).
 */
export function AuditEventList({
  events,
  linkTarget = true,
}: {
  events: AuditEvent[];
  linkTarget?: boolean;
}) {
  if (events.length === 0) {
    return <div className="text-sm text-muted italic py-4">No audit events yet.</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className="py-3 flex items-start gap-4">
          <ActionPill action={e.action} />
          <div className="min-w-0 flex-1">
            <div className="text-sm">
              <span className="font-medium">
                {linkTarget && e.target_id ? (
                  <Link
                    to={`/pipelines/${e.target_id}`}
                    className="text-text hover:text-accent"
                  >
                    {e.target_name ?? e.target_id}
                  </Link>
                ) : (
                  e.target_name ?? e.target_id ?? "—"
                )}
              </span>
              <span className="text-muted">
                {" "}
                by <span className="mono text-xs">{e.actor}</span>
              </span>
            </div>
            <div className="text-xs text-muted mt-0.5">
              {relativeTime(e.created_at)} · {new Date(e.created_at).toISOString()}
            </div>
            {hasDetail(e) && (
              <details className="mt-1.5">
                <summary className="text-xs text-accent cursor-pointer hover:underline">
                  details
                </summary>
                <pre className="mono text-[11px] leading-relaxed mt-1 p-2 rounded bg-bg border border-border overflow-x-auto">
                  {JSON.stringify(e.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ActionPill({ action }: { action: AuditEvent["action"] }) {
  if (action === "pipeline.create") return <Pill tone="ok">created</Pill>;
  if (action === "pipeline.update") return <Pill tone="accent">updated</Pill>;
  if (action === "pipeline.delete") return <Pill tone="danger">deleted</Pill>;
  return <Pill tone="muted">{action}</Pill>;
}

function hasDetail(e: AuditEvent): boolean {
  return e.metadata !== null && typeof e.metadata === "object" && Object.keys(e.metadata).length > 0;
}
