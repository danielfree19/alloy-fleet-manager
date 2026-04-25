import { useState } from "react";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import {
  createToken,
  listMyTokens,
  listRoles,
  revokeToken,
} from "@/api/identity";
import type { ApiToken, Role } from "@/api/types";
import { ApiError } from "@/api/client";
import { toast } from "@/store/toasts";

/**
 * API tokens settings page.
 *
 * Two states:
 *   - Default list view of the caller's tokens (active + revoked).
 *   - Modal-style "create token" panel that, on success, replaces
 *     itself with a "here is the plaintext" panel — the ONLY time
 *     the user will ever see the secret. Closing this panel returns
 *     to the list, and the secret is unrecoverable.
 *
 * Tokens carry a subset of the caller's roles; the role picker only
 * lists roles available via /roles (which the manager already
 * filters to "things this user can see").
 */
export function SettingsTokens() {
  const tokens = useAsync(() => listMyTokens(), []);
  const roles = useAsync(() => listRoles(), []);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{
    token: string;
    name: string;
    prefix: string;
  } | null>(null);

  return (
    <>
      <PageHeader
        title="API tokens"
        subtitle="Long-lived bearer tokens for fleetctl, Terraform, CI, Alloy collectors, or any other programmatic client. Tokens carry a subset of your roles. For Alloy, pick the built-in `agent` role."
        actions={
          <>
            <button type="button" className="btn" onClick={tokens.reload}>
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setJustCreated(null);
                setCreating(true);
              }}
            >
              New token
            </button>
          </>
        }
      />

      {justCreated && (
        <div className="card p-6 mb-6 border-accent/40 bg-accent-soft/30">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold">Token created</div>
              <p className="text-xs text-muted mt-1">
                This is the only time you'll see the full token. Copy it now —
                we'll only ever show the prefix <code className="mono">{justCreated.prefix}</code>{" "}
                ever again.
              </p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setJustCreated(null)}
            >
              I've copied it
            </button>
          </div>
          <div className="mt-3 rounded-md bg-bg/60 border border-border p-3 mono text-xs break-all select-all">
            {justCreated.token}
          </div>
        </div>
      )}

      {creating && (
        <CreateTokenForm
          roles={roles.data ?? []}
          onCancel={() => setCreating(false)}
          onCreated={(token, name, prefix) => {
            setCreating(false);
            setJustCreated({ token, name, prefix });
            tokens.reload();
          }}
        />
      )}

      <AsyncBoundary state={tokens}>
        {(rows) => <TokenList rows={rows} onRevoked={tokens.reload} />}
      </AsyncBoundary>
    </>
  );
}

function TokenList({
  rows,
  onRevoked,
}: {
  rows: ApiToken[];
  onRevoked: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="card p-8 text-sm text-muted text-center">
        You don't have any API tokens yet. Click "New token" above to create
        one for fleetctl, Terraform, or your CI pipeline.
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-border/30 text-xs text-muted">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Name</th>
            <th className="text-left px-4 py-2 font-medium">Prefix</th>
            <th className="text-left px-4 py-2 font-medium">Roles</th>
            <th className="text-left px-4 py-2 font-medium">Last used</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-border">
              <td className="px-4 py-2 font-medium">{t.name}</td>
              <td className="px-4 py-2 mono text-xs">fmt_{t.token_prefix}…</td>
              <td className="px-4 py-2 text-xs">
                {t.roles.length === 0
                  ? <span className="text-muted">no roles</span>
                  : t.roles.map((r) => r.name).join(", ")}
              </td>
              <td className="px-4 py-2 text-xs text-muted">
                {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
              </td>
              <td className="px-4 py-2">
                {t.revoked_at ? (
                  <span className="text-xs text-muted">revoked</span>
                ) : t.expires_at && Date.parse(t.expires_at) <= Date.now() ? (
                  <span className="text-xs text-muted">expired</span>
                ) : (
                  <span className="text-xs text-accent">active</span>
                )}
              </td>
              <td className="px-4 py-2 text-right">
                {!t.revoked_at && (
                  <button
                    type="button"
                    className="btn btn-danger text-xs"
                    onClick={async () => {
                      if (!confirm(`Revoke token "${t.name}"? Clients using it will start failing immediately.`)) return;
                      try {
                        await revokeToken(t.id);
                        toast.success("Token revoked.");
                        onRevoked();
                      } catch (err) {
                        toast.error(err instanceof ApiError ? err.message : "Failed to revoke");
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateTokenForm({
  roles,
  onCancel,
  onCreated,
}: {
  roles: Role[];
  onCancel: () => void;
  onCreated: (token: string, name: string, prefix: string) => void;
}) {
  const [name, setName] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleRole(id: string) {
    setRoleIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the token a name so you can identify it later.");
      return;
    }
    setBusy(true);
    try {
      const res = await createToken({
        name: name.trim(),
        role_ids: roleIds,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      onCreated(res.token, res.api_token.name, res.api_token.token_prefix);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? "You can only assign roles you yourself have."
            : err.message
          : "Something went wrong.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 mb-6 space-y-4">
      <div className="text-sm font-semibold">New API token</div>
      <div className="space-y-1">
        <label className="text-xs text-muted block" htmlFor="token-name">
          Name
        </label>
        <input
          id="token-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ci-prod, terraform-staging"
          required
          autoFocus
        />
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted">Roles</div>
        {roles.length === 0 ? (
          <div className="text-xs text-muted italic">No roles available.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <label
                key={r.id}
                title={r.description || undefined}
                className={`text-xs rounded-md border px-3 py-1.5 cursor-pointer transition ${
                  roleIds.includes(r.id)
                    ? "bg-accent-soft border-accent/40 text-accent"
                    : "border-border text-text/80 hover:bg-border/40"
                }`}
              >
                <input
                  type="checkbox"
                  className="hidden"
                  checked={roleIds.includes(r.id)}
                  onChange={() => toggleRole(r.id)}
                />
                {r.name}
                {r.builtin && <span className="ml-1 text-muted/70">(built-in)</span>}
              </label>
            ))}
          </div>
        )}
        {roles.some((r) => r.name === "agent") && (
          <p className="text-[11px] text-muted/70 pt-1">
            Pick <span className="mono">agent</span> for tokens you'll hand to
            an Alloy instance — it grants only{" "}
            <span className="mono">collectors.poll</span> (the remotecfg RPCs)
            and nothing else.
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted block" htmlFor="expires-at">
          Expires at <span className="text-muted/70">(optional)</span>
        </label>
        <input
          id="expires-at"
          type="datetime-local"
          className="input"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        <p className="text-[11px] text-muted/70">
          Leave blank for a non-expiring token. The token's last-used timestamp
          and audit attribution still let you trace activity.
        </p>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex gap-2 justify-end pt-2">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}
