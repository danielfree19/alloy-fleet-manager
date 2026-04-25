import { useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import {
  createUser,
  deleteUser,
  linkUserToSso,
  listRoles,
  listSsoProviders,
  listUsers,
  resetUserPassword,
  unlinkUserSso,
  updateUser,
  type SsoProviderConfig,
} from "@/api/identity";
import type { Role, User } from "@/api/types";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { useAuthStore, useHasPermission } from "@/store/auth";
import { toast } from "@/store/toasts";

/**
 * Users settings page.
 *
 * `users.read` is required to view; `users.write` is required for any
 * mutation (create / update / disable / delete / reset password).
 * The Layout already gates the menu item, but we re-check permissions
 * here so a deep-link still degrades gracefully.
 */
export function SettingsUsers() {
  const canWrite = useHasPermission("users.write");
  // sso.write gates the Link/Unlink actions specifically. We deliberately
  // *don't* require sso.read for the badge — viewing whether a user is
  // SSO-managed is part of the existing /users payload (it's been there
  // since OIDC was added) and gating the badge would surprise admins.
  const canManageSso = useHasPermission("sso.write");
  const users = useAsync(() => listUsers(), []);
  const roles = useAsync(() => listRoles(), []);
  // SSO providers list — only fetched when the actor can manage SSO.
  // Used to populate the "Link to SSO…" provider picker.
  const ssoCanRead = useHasPermission("sso.read");
  const providers = useAsync(
    () => (ssoCanRead ? listSsoProviders() : Promise.resolve([])),
    [ssoCanRead],
  );
  const [creating, setCreating] = useState(false);
  const [ssoOnly, setSsoOnly] = useState(false);

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Accounts that can sign in. Local accounts use email and password; SSO-managed accounts sign in via an identity provider and have their roles synced from group claims on every login."
        actions={
          <>
            <button type="button" className="btn" onClick={users.reload}>
              Refresh
            </button>
            {canWrite && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreating(true)}
              >
                New user
              </button>
            )}
          </>
        }
      />

      {creating && (
        <CreateUserForm
          roles={roles.data ?? []}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            users.reload();
          }}
        />
      )}

      <div className="flex items-center gap-2 mb-4 text-xs">
        <button
          type="button"
          onClick={() => setSsoOnly((v) => !v)}
          className={`rounded-md border px-3 py-1.5 transition ${
            ssoOnly
              ? "bg-accent-soft border-accent/40 text-accent"
              : "border-border text-text/80 hover:bg-border/40"
          }`}
        >
          {ssoOnly ? "✓ " : ""}SSO-managed only
        </button>
      </div>

      <AsyncBoundary state={users}>
        {(rows) => (
          <UserList
            rows={ssoOnly ? rows.filter((u) => u.oidc_issuer) : rows}
            roles={roles.data ?? []}
            providers={providers.data ?? []}
            canWrite={canWrite}
            canManageSso={canManageSso}
            onChanged={users.reload}
          />
        )}
      </AsyncBoundary>
    </>
  );
}

function UserList({
  rows,
  roles,
  providers,
  canWrite,
  canManageSso,
  onChanged,
}: {
  rows: User[];
  roles: Role[];
  providers: SsoProviderConfig[];
  canWrite: boolean;
  canManageSso: boolean;
  onChanged: () => void;
}) {
  const meId = useAuthStore((s) => s.actor?.user_id ?? null);
  if (rows.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-muted">No users yet.</div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-border/30 text-xs text-muted">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Email</th>
            <th className="text-left px-4 py-2 font-medium">Name</th>
            <th className="text-left px-4 py-2 font-medium">Roles</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              roles={roles}
              providers={providers}
              canWrite={canWrite}
              canManageSso={canManageSso}
              isSelf={u.id === meId}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  user,
  roles,
  providers,
  canWrite,
  canManageSso,
  isSelf,
  onChanged,
}: {
  user: User;
  roles: Role[];
  providers: SsoProviderConfig[];
  canWrite: boolean;
  canManageSso: boolean;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  // Resolve "this user is bound to provider X" by matching their
  // `oidc_issuer` against each known provider's issuer URL. Falls
  // back to the literal issuer string when the provider has been
  // removed since the user was provisioned.
  const ssoProviderLabel = useMemo(() => {
    if (!user.oidc_issuer) return null;
    const match = providers.find(
      (p) => p.issuer && p.issuer.replace(/\/$/, "") === user.oidc_issuer!.replace(/\/$/, ""),
    );
    return match?.display_name ?? user.oidc_issuer;
  }, [user.oidc_issuer, providers]);

  async function toggleDisabled() {
    // Disabling yourself is now allowed (so a single-user deployment
    // can shut their own account down) but it's destructive: it
    // immediately invalidates your active sessions, and you won't be
    // able to sign back in until another admin re-enables you. Make
    // sure the operator is awake.
    if (isSelf && !user.disabled) {
      const ok = window.confirm(
        "Disable your own account? You'll be signed out immediately and won't be able to sign back in unless another admin re-enables you, or you have ADMIN_TOKEN access.",
      );
      if (!ok) return;
    }
    try {
      await updateUser(user.id, { disabled: !user.disabled });
      toast.success(user.disabled ? "User enabled." : "User disabled.");
      onChanged();
    } catch (err) {
      // Surface the dedicated last-admin-lockout error in plain English
      // — the generic ApiError message ("last_admin_lockout") isn't
      // useful on its own.
      if (err instanceof ApiError && err.status === 400) {
        const code = (err.details as { error?: string } | null)?.error;
        if (code === "last_admin_lockout") {
          toast.error(
            "Can't disable: this is the last active admin. Promote another user to admin first.",
          );
          return;
        }
      }
      toast.error(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function onDelete() {
    if (!confirm(`Delete user ${user.email}? This is permanent and removes all their API tokens. Audit history is preserved.`)) return;
    try {
      await deleteUser(user.id);
      toast.success("User deleted.");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const code = (err.details as { error?: string } | null)?.error;
        if (code === "last_admin_lockout") {
          toast.error(
            "Can't delete: this is the last active admin. Promote another user to admin first.",
          );
          return;
        }
      }
      toast.error(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function onUnlinkSso() {
    if (
      !confirm(
        `Unlink ${user.email} from SSO? They'll revert to a local-password account, but won't have a usable password until an admin resets it. Their roles are preserved as a snapshot of the IdP state at unlink time.`,
      )
    )
      return;
    try {
      await unlinkUserSso(user.id);
      toast.success("SSO link removed.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function onResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    try {
      await resetUserPassword(user.id, newPassword);
      toast.success("Password reset. The user must sign in again on every device.");
      setResetting(false);
      setNewPassword("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed");
    }
  }

  return (
    <>
      <tr className="border-t border-border">
        <td className="px-4 py-2 font-medium">
          <div className="flex items-center gap-2">
            <span>{user.email}</span>
            {ssoProviderLabel && (
              <span
                className="text-[10px] uppercase tracking-wide rounded bg-accent-soft text-accent px-1.5 py-0.5"
                title={`Bound to ${ssoProviderLabel}. Roles synced from IdP groups on every login.`}
              >
                SSO · {ssoProviderLabel}
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-muted">{user.name ?? "—"}</td>
        <td className="px-4 py-2 text-xs">
          {user.roles.length === 0
            ? <span className="text-muted">no roles</span>
            : user.roles.map((r) => r.name).join(", ")}
        </td>
        <td className="px-4 py-2">
          {user.disabled ? (
            <span className="text-xs text-muted">disabled</span>
          ) : (
            <span className="text-xs text-accent">active</span>
          )}
        </td>
        <td className="px-4 py-2 text-right">
          {canWrite && (
            <div className="flex gap-1.5 justify-end">
              <button
                type="button"
                className="btn text-xs"
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Close" : "Edit"}
              </button>
              {/* Local password reset is meaningless for SSO-only users —
                  there's no password to set. The button stays so admins
                  can still bootstrap a password BEFORE unlinking. */}
              <button
                type="button"
                className="btn text-xs"
                onClick={() => setResetting((v) => !v)}
              >
                Reset password
              </button>
              {canManageSso && (
                user.oidc_issuer ? (
                  <button
                    type="button"
                    className="btn text-xs"
                    onClick={onUnlinkSso}
                  >
                    Unlink SSO
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn text-xs"
                    onClick={() => setLinking((v) => !v)}
                  >
                    {linking ? "Close link" : "Link to SSO…"}
                  </button>
                )
              )}
              <button
                type="button"
                className="btn text-xs"
                onClick={toggleDisabled}
                title={
                  isSelf && !user.disabled
                    ? "Disabling yourself signs you out immediately"
                    : undefined
                }
              >
                {user.disabled ? "Enable" : "Disable"}
              </button>
              <button
                type="button"
                className="btn btn-danger text-xs"
                onClick={onDelete}
                disabled={isSelf}
                title={isSelf ? "You can't delete yourself" : undefined}
              >
                Delete
              </button>
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="border-t border-border bg-bg/40">
          <td colSpan={5} className="px-4 py-3">
            <EditRoles
              user={user}
              roles={roles}
              onSaved={() => {
                setEditing(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
      {linking && (
        <tr className="border-t border-border bg-bg/40">
          <td colSpan={5} className="px-4 py-3">
            <LinkSsoForm
              user={user}
              providers={providers}
              onCancel={() => setLinking(false)}
              onLinked={() => {
                setLinking(false);
                onChanged();
              }}
            />
          </td>
        </tr>
      )}
      {resetting && (
        <tr className="border-t border-border bg-bg/40">
          <td colSpan={5} className="px-4 py-3">
            <form onSubmit={onResetPassword} className="flex items-end gap-2 max-w-md">
              <div className="grow space-y-1">
                <label className="text-xs text-muted block" htmlFor={`new-password-${user.id}`}>
                  New password for {user.email}
                </label>
                <input
                  id={`new-password-${user.id}`}
                  type="password"
                  className="input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <button type="submit" className="btn btn-primary">
                Set password
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setResetting(false);
                  setNewPassword("");
                }}
              >
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

function EditRoles({
  user,
  roles,
  onSaved,
}: {
  user: User;
  roles: Role[];
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(new Set(user.roles.map((r) => r.id)));
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSave() {
    setBusy(true);
    try {
      await updateUser(user.id, { role_ids: Array.from(selected) });
      toast.success("Roles updated.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const code = (err.details as { error?: string } | null)?.error;
        if (code === "last_admin_lockout") {
          toast.error(
            "Can't remove admin role: this is the last active admin. Promote another user to admin first.",
          );
          setBusy(false);
          return;
        }
      }
      toast.error(err instanceof ApiError ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">Roles for {user.email}</div>
      <div className="flex flex-wrap gap-2">
        {roles.map((r) => (
          <label
            key={r.id}
            className={`text-xs rounded-md border px-3 py-1.5 cursor-pointer transition ${
              selected.has(r.id)
                ? "bg-accent-soft border-accent/40 text-accent"
                : "border-border text-text/80 hover:bg-border/40"
            }`}
          >
            <input
              type="checkbox"
              className="hidden"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
            />
            {r.name}
            {r.builtin && <span className="ml-1 text-muted/70">(built-in)</span>}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save roles"}
        </button>
      </div>
    </div>
  );
}

function CreateUserForm({
  roles,
  onCancel,
  onCreated,
}: {
  roles: Role[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(id: string) {
    setRoleIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createUser({
        email: email.trim(),
        name: name.trim() || null,
        password: password || undefined,
        role_ids: roleIds,
      });
      toast.success("User created.");
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? "Email already in use."
            : err.message
          : "Something went wrong.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 mb-6 space-y-4">
      <div className="text-sm font-semibold">New user</div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="new-user-email">
            Email
          </label>
          <input
            id="new-user-email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="new-user-name">
            Name <span className="text-muted/70">(optional)</span>
          </label>
          <input
            id="new-user-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted block" htmlFor="new-user-password">
          Initial password
        </label>
        <input
          id="new-user-password"
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <p className="text-[11px] text-muted/70">
          The user can change this from "My account" after signing in. Min 8 characters.
        </p>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted">Roles</div>
        <div className="flex flex-wrap gap-2">
          {roles.map((r) => (
            <label
              key={r.id}
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
            </label>
          ))}
        </div>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex gap-2 justify-end pt-2">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </button>
      </div>
    </form>
  );
}

/**
 * Link an existing local user to an SSO identity. Used when the email-
 * collision rejection has fired: the user has a local account, the IdP
 * is reporting the same email, and the admin wants to bind them.
 *
 * After linking, the user's NEXT SSO sign-in will:
 *   - succeed (no more `email_collision_local_user` rejection)
 *   - replace their roles with whatever the IdP groups map to
 *
 * They keep their local password until an admin resets it (or the user
 * is unlinked again).
 */
function LinkSsoForm({
  user,
  providers,
  onCancel,
  onLinked,
}: {
  user: User;
  providers: SsoProviderConfig[];
  onCancel: () => void;
  onLinked: () => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!providerId || !subject.trim()) {
      setError("Pick a provider and paste the IdP subject (sub claim).");
      return;
    }
    setBusy(true);
    try {
      await linkUserToSso(user.id, providerId, subject.trim());
      toast.success("User linked. Their next SSO sign-in will replace their roles from group claims.");
      onLinked();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const code = (err.details as { error?: string } | null)?.error;
        if (code === "already_linked") {
          setError("This user already has an SSO link. Unlink first to change provider.");
        } else if (code === "subject_already_bound") {
          setError("Another user is already bound to this (provider, subject). Unlink them first.");
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      }
      setBusy(false);
    }
  }

  if (providers.length === 0) {
    return (
      <div className="text-xs text-muted">
        No SSO providers are configured. Add one in{" "}
        <a className="underline" href="/ui/settings/identity-providers">
          Identity providers
        </a>{" "}
        first.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1 min-w-[160px]">
        <label className="text-xs text-muted block">Provider</label>
        <select
          className="input"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="grow space-y-1 min-w-[260px]">
        <label className="text-xs text-muted block">
          Subject (the <code className="mono">sub</code> claim from the IdP)
        </label>
        <input
          className="input mono"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="11111111-2222-3333-4444-555555555555"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Linking…" : "Link"}
      </button>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {error && (
        <div className="basis-full text-xs text-danger pt-1">{error}</div>
      )}
    </form>
  );
}
