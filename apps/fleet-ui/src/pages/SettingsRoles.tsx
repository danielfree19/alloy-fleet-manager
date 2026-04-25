import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  createRole,
  deleteRole,
  listRoles,
  updateRole,
} from "@/api/identity";
import type { Permission, Role } from "@/api/types";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { useHasPermission } from "@/store/auth";
import { toast } from "@/store/toasts";

/**
 * Roles settings page.
 *
 * Built-in roles (admin / editor / viewer) are read-only here — the
 * server enforces this too, but disabling the controls in the UI
 * makes the rule discoverable.
 *
 * The permission grid lists every defined permission so operators can
 * see exactly what each role grants. Adding a new permission to the
 * manager doesn't need a UI change — we render whatever the server
 * returns plus the canonical full list (so unselected permissions
 * still show as columns).
 */
const ALL_PERMISSIONS: Permission[] = [
  "pipelines.read",
  "pipelines.create",
  "pipelines.update",
  "pipelines.delete",
  "collectors.read",
  "collectors.poll",
  "catalog.read",
  "audit.read",
  "users.read",
  "users.write",
  "tokens.read",
  "tokens.write",
  "sso.read",
  "sso.write",
];

export function SettingsRoles() {
  const canWrite = useHasPermission("users.write");
  const roles = useAsync(() => listRoles(), []);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="A role is a named bundle of permissions. Built-in roles cover the common cases; create a custom role for fine-grained control."
        actions={
          <>
            <button type="button" className="btn" onClick={roles.reload}>
              Refresh
            </button>
            {canWrite && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreating(true)}
              >
                New role
              </button>
            )}
          </>
        }
      />

      {creating && (
        <CreateRoleForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            roles.reload();
          }}
        />
      )}

      <AsyncBoundary state={roles}>
        {(rows) => (
          <RoleList rows={rows} canWrite={canWrite} onChanged={roles.reload} />
        )}
      </AsyncBoundary>
    </>
  );
}

function RoleList({
  rows,
  canWrite,
  onChanged,
}: {
  rows: Role[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <RoleCard key={r.id} role={r} canWrite={canWrite} onChanged={onChanged} />
      ))}
    </div>
  );
}

function RoleCard({
  role,
  canWrite,
  onChanged,
}: {
  role: Role;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const editable = canWrite && !role.builtin;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">{role.name}</div>
            {role.builtin && (
              <span className="text-[10px] uppercase tracking-wide rounded bg-border/50 text-muted px-1.5 py-0.5">
                built-in
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-1">{role.description || "—"}</p>
        </div>
        {editable && (
          <div className="flex gap-1.5">
            <button
              type="button"
              className="btn text-xs"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Close" : "Edit"}
            </button>
            <button
              type="button"
              className="btn btn-danger text-xs"
              onClick={async () => {
                if (!confirm(`Delete role "${role.name}"? Users with this role will lose its permissions.`)) return;
                try {
                  await deleteRole(role.id);
                  toast.success("Role deleted.");
                  onChanged();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "Failed");
                }
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="mt-4">
        {editing ? (
          <EditPermissions role={role} onSaved={() => { setEditing(false); onChanged(); }} />
        ) : (
          <PermissionGrid permissions={role.permissions} />
        )}
      </div>
    </div>
  );
}

function PermissionGrid({ permissions }: { permissions: Permission[] }) {
  const set = new Set(permissions);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 text-xs">
      {ALL_PERMISSIONS.map((p) => (
        <div
          key={p}
          className={`rounded border px-2 py-1 mono ${
            set.has(p)
              ? "border-accent/40 bg-accent-soft/50 text-text"
              : "border-border text-muted/60"
          }`}
        >
          {set.has(p) ? "✓ " : "  "}
          {p}
        </div>
      ))}
    </div>
  );
}

function EditPermissions({ role, onSaved }: { role: Role; onSaved: () => void }) {
  const [selected, setSelected] = useState(new Set<Permission>(role.permissions));
  const [description, setDescription] = useState(role.description);
  const [busy, setBusy] = useState(false);

  function toggle(p: Permission) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function onSave() {
    setBusy(true);
    try {
      await updateRole(role.id, {
        description,
        permissions: Array.from(selected),
      });
      toast.success("Role updated.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-muted block" htmlFor={`role-desc-${role.id}`}>
          Description
        </label>
        <input
          id={`role-desc-${role.id}`}
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 text-xs">
        {ALL_PERMISSIONS.map((p) => (
          <label
            key={p}
            className={`rounded border px-2 py-1 mono cursor-pointer ${
              selected.has(p)
                ? "border-accent/40 bg-accent-soft/50 text-text"
                : "border-border text-muted/60 hover:bg-border/30"
            }`}
          >
            <input
              type="checkbox"
              className="hidden"
              checked={selected.has(p)}
              onChange={() => toggle(p)}
            />
            {selected.has(p) ? "✓ " : "  "}
            {p}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function CreateRoleForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState(new Set<Permission>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(p: Permission) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
      setError("Role name must be a lowercase slug (letters, numbers, hyphens, underscores).");
      return;
    }
    setBusy(true);
    try {
      await createRole({
        name,
        description,
        permissions: Array.from(selected),
      });
      toast.success("Role created.");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 mb-6 space-y-4">
      <div className="text-sm font-semibold">New role</div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="new-role-name">
            Name (slug)
          </label>
          <input
            id="new-role-name"
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ops-readonly"
            required
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block" htmlFor="new-role-description">
            Description
          </label>
          <input
            id="new-role-description"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Read-only access for SREs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted">Permissions</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 text-xs">
          {ALL_PERMISSIONS.map((p) => (
            <label
              key={p}
              className={`rounded border px-2 py-1 mono cursor-pointer ${
                selected.has(p)
                  ? "border-accent/40 bg-accent-soft/50 text-text"
                  : "border-border text-muted/60 hover:bg-border/30"
              }`}
            >
              <input
                type="checkbox"
                className="hidden"
                checked={selected.has(p)}
                onChange={() => toggle(p)}
              />
              {selected.has(p) ? "✓ " : "  "}
              {p}
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
          {busy ? "Creating…" : "Create role"}
        </button>
      </div>
    </form>
  );
}
