import { useState } from "react";
import { listAuditEvents } from "@/api/audit";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { AuditEventList } from "@/components/AuditEventList";
import { PageHeader } from "@/components/PageHeader";

/**
 * Settings → SSO activity.
 *
 * Filtered audit-log view. Pulls just the SSO-related rows so admins
 * can quickly see who signed in via which provider, who was rejected
 * and why, and when role-sync changed someone's roles. Reuses the
 * generic `AuditEventList` component — the only thing this page does
 * over /audit is preset the action filter to the SSO actions and
 * surface a per-action toggle.
 *
 * Filter controls:
 *   - "All SSO activity" (default): three actions OR-filtered
 *     server-side via `?actions=auth.sso.login,auth.sso.rejected,auth.sso.role_sync`.
 *   - "Successful logins": only `auth.sso.login`.
 *   - "Rejections": only `auth.sso.rejected` — the on-call view.
 *   - "Role sync": only `auth.sso.role_sync`.
 */

type Mode = "all" | "login" | "rejected" | "role_sync";

const MODE_TO_ACTIONS: Record<Mode, string> = {
  all: "auth.sso.login,auth.sso.rejected,auth.sso.role_sync",
  login: "auth.sso.login",
  rejected: "auth.sso.rejected",
  role_sync: "auth.sso.role_sync",
};

export function SettingsSsoActivity() {
  const [mode, setMode] = useState<Mode>("all");
  const state = useAsync(
    () =>
      listAuditEvents({
        actions: MODE_TO_ACTIONS[mode],
        limit: 200,
      }),
    [mode],
  );

  return (
    <>
      <PageHeader
        title="SSO activity"
        subtitle="Filtered audit-log view of SSO sign-ins, rejections, and role syncs. Use this page to debug failing IdP integrations and to audit who's signing in via which provider."
        actions={
          <button className="btn" onClick={state.reload}>
            Refresh
          </button>
        }
      />
      <div className="card p-4 mb-6 flex flex-wrap items-center gap-2">
        <ModeButton value="all" current={mode} onChange={setMode}>
          All SSO activity
        </ModeButton>
        <ModeButton value="login" current={mode} onChange={setMode}>
          Successful logins
        </ModeButton>
        <ModeButton value="rejected" current={mode} onChange={setMode}>
          Rejections
        </ModeButton>
        <ModeButton value="role_sync" current={mode} onChange={setMode}>
          Role sync
        </ModeButton>
      </div>
      <div className="card p-5">
        <AsyncBoundary state={state}>
          {(events) =>
            events.length === 0 ? (
              <div className="text-sm text-muted py-8 text-center">
                No SSO activity in this view.{" "}
                {mode === "rejected"
                  ? "Nobody's been rejected — that's a good sign."
                  : "If SSO is configured, sign in via the IdP to see events here."}
              </div>
            ) : (
              <AuditEventList events={events} />
            )
          }
        </AsyncBoundary>
      </div>
    </>
  );
}

function ModeButton({
  value,
  current,
  onChange,
  children,
}: {
  value: Mode;
  current: Mode;
  onChange: (m: Mode) => void;
  children: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`text-xs rounded-md border px-3 py-1.5 transition ${
        active
          ? "bg-accent-soft border-accent/40 text-accent"
          : "border-border text-text/80 hover:bg-border/40"
      }`}
    >
      {children}
    </button>
  );
}
