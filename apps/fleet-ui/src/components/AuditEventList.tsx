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
                <TargetLabel event={e} linkTarget={linkTarget} />
              </span>
              <span className="text-muted">
                {" "}
                <span className="text-[11px] uppercase tracking-wide">
                  {e.target_kind}
                </span>
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
  // Pipelines
  if (action === "pipeline.create") return <Pill tone="ok">created</Pill>;
  if (action === "pipeline.update") return <Pill tone="accent">updated</Pill>;
  if (action === "pipeline.delete") return <Pill tone="danger">deleted</Pill>;
  // Auth
  if (action === "auth.login") return <Pill tone="ok">signed in</Pill>;
  if (action === "auth.logout") return <Pill tone="muted">signed out</Pill>;
  if (action === "auth.password.change") return <Pill tone="accent">password changed</Pill>;
  // Users
  if (action === "user.create") return <Pill tone="ok">user created</Pill>;
  if (action === "user.update") return <Pill tone="accent">user updated</Pill>;
  if (action === "user.delete") return <Pill tone="danger">user deleted</Pill>;
  if (action === "user.password.reset") return <Pill tone="accent">password reset</Pill>;
  // Roles
  if (action === "role.create") return <Pill tone="ok">role created</Pill>;
  if (action === "role.update") return <Pill tone="accent">role updated</Pill>;
  if (action === "role.delete") return <Pill tone="danger">role deleted</Pill>;
  // API tokens
  if (action === "token.create") return <Pill tone="ok">token created</Pill>;
  if (action === "token.revoke") return <Pill tone="danger">token revoked</Pill>;
  return <Pill tone="muted">{action}</Pill>;
}

/**
 * Render the target as a link when we have a sensible UI destination
 * for it, otherwise as plain text. Linking is opt-in per call (the
 * pipeline edit page passes linkTarget=false because every row already
 * points at the same pipeline).
 */
function TargetLabel({
  event,
  linkTarget,
}: {
  event: AuditEvent;
  linkTarget: boolean;
}) {
  const display = event.target_name ?? event.target_id ?? "—";
  if (!linkTarget || !event.target_id) {
    return <>{display}</>;
  }
  let href: string | null = null;
  switch (event.target_kind) {
    case "pipeline":
      href = `/pipelines/${event.target_id}`;
      break;
    case "user":
      href = `/settings/users`;
      break;
    case "role":
      href = `/settings/roles`;
      break;
    case "api_token":
      href = `/settings/tokens`;
      break;
    default:
      href = null;
  }
  if (!href) return <>{display}</>;
  return (
    <Link to={href} className="text-text hover:text-accent">
      {display}
    </Link>
  );
}

function hasDetail(e: AuditEvent): boolean {
  return e.metadata !== null && typeof e.metadata === "object" && Object.keys(e.metadata).length > 0;
}
