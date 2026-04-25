import { useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import {
  createSsoProvider,
  deleteSsoProvider,
  listRoles,
  listSsoProviders,
  testSsoProvider,
  updateSsoProvider,
  type SsoProviderConfig,
  type SsoProviderInput,
  type TestConnectionResult,
} from "@/api/identity";
import type { Role } from "@/api/types";
import { AsyncBoundary, useAsync } from "@/components/Async";
import { PageHeader } from "@/components/PageHeader";
import { useHasPermission } from "@/store/auth";
import { toast } from "@/store/toasts";

/**
 * Settings → Identity providers.
 *
 * Lists every SSO IdP currently visible to the manager — the union
 * of YAML-seeded providers (badged "managed via YAML") and DB rows
 * created from this UI ("managed in UI"). YAML rows can be edited
 * here too: the first save materializes a `source='ui'` overlay row
 * that shadows the YAML config until an admin deletes it.
 *
 * Permission gating:
 *   - sso.read  → required to view (Layout already hides the link).
 *   - sso.write → required to create / edit / delete / test.
 * The page degrades gracefully for sso.read-only actors: the editor
 * is read-only and the "Test connection" button stays available
 * (test is `sso.read`).
 */
export function SettingsIdentityProviders() {
  const canWrite = useHasPermission("sso.write");
  const providers = useAsync(() => listSsoProviders(), []);
  const roles = useAsync(() => listRoles(), []);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Identity providers"
        subtitle="Configure OIDC providers for SSO. The YAML file at SSO_CONFIG_FILE seeds providers on boot; admin edits made here override the YAML defaults per provider."
        actions={
          <>
            <button type="button" className="btn" onClick={providers.reload}>
              Refresh
            </button>
            {canWrite && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreating(true)}
              >
                Add provider
              </button>
            )}
          </>
        }
      />

      {creating && (
        <ProviderEditor
          mode="create"
          provider={null}
          roles={roles.data ?? []}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            providers.reload();
          }}
        />
      )}

      <AsyncBoundary state={providers}>
        {(rows) =>
          rows.length === 0 ? (
            <div className="card p-8 text-center text-sm text-muted">
              No SSO providers configured. Add one via this UI or set{" "}
              <code className="mono">SSO_CONFIG_FILE</code> on the
              fleet-manager process to bootstrap providers from YAML.
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  roles={roles.data ?? []}
                  canWrite={canWrite}
                  onChanged={providers.reload}
                />
              ))}
            </div>
          )
        }
      </AsyncBoundary>
    </>
  );
}

function ProviderCard({
  provider,
  roles,
  canWrite,
  onChanged,
}: {
  provider: SsoProviderConfig;
  roles: Role[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState<TestConnectionResult | null>(null);
  const [busyTest, setBusyTest] = useState(false);

  async function onTest() {
    setBusyTest(true);
    try {
      const result = await testSsoProvider(provider.id);
      setTesting(result);
      if (result.ok) toast.success(`Connection to ${provider.display_name} OK.`);
      else toast.error(`Connection failed: ${result.error ?? "unknown"}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed");
    } finally {
      setBusyTest(false);
    }
  }

  async function onDelete() {
    if (
      !confirm(
        `Delete provider "${provider.display_name}"? Users currently bound to this provider won't be able to sign in until another admin re-adds it. Their accounts and roles are preserved.`,
      )
    )
      return;
    try {
      await deleteSsoProvider(provider.id);
      toast.success("Provider removed.");
      onChanged();
    } catch (err) {
      // 409 happens when YAML still defines the provider — the UI
      // can't shadow-delete a YAML row, the operator must edit the
      // YAML file. Surface this clearly.
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          "This provider is defined in the YAML file. Remove it there and restart the manager.",
        );
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Failed");
    }
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">{provider.display_name}</div>
            <code className="text-xs text-muted mono">{provider.id}</code>
            <span
              className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${
                provider.source === "yaml"
                  ? "bg-border/50 text-muted"
                  : "bg-accent-soft text-accent"
              }`}
              title={
                provider.source === "yaml"
                  ? "Configured via the YAML file. Edits here will create an override row."
                  : "Configured via this UI."
              }
            >
              {provider.source === "yaml" ? "managed via YAML" : "managed in UI"}
            </span>
          </div>
          <p className="text-xs text-muted mt-1 mono">
            {provider.issuer ?? <em className="text-muted/60">no issuer</em>}
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            className="btn text-xs"
            onClick={onTest}
            disabled={busyTest}
            title="Probe the IdP's discovery + JWKS endpoints."
          >
            {busyTest ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => setEditing((v) => !v)}
            disabled={!canWrite}
            title={canWrite ? undefined : "Requires sso.write"}
          >
            {editing ? "Close" : "Edit"}
          </button>
          {canWrite && provider.source === "ui" && (
            <button
              type="button"
              className="btn btn-danger text-xs"
              onClick={onDelete}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {testing && <TestResultBox result={testing} />}

      <ProviderSummary provider={provider} roles={roles} />

      {editing && (
        <ProviderEditor
          mode="edit"
          provider={provider}
          roles={roles}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TestResultBox({ result }: { result: TestConnectionResult }) {
  if (result.ok) {
    return (
      <div className="text-xs rounded border border-accent/40 bg-accent-soft/40 px-3 py-2 space-y-1">
        <div className="text-accent font-medium">Connection OK</div>
        <div className="text-muted">
          authorization_endpoint: <code className="mono">{result.authorization_endpoint ?? "n/a"}</code>
        </div>
        <div className="text-muted">
          token_endpoint: <code className="mono">{result.token_endpoint ?? "n/a"}</code>
        </div>
        <div className="text-muted">
          jwks_keys: <code className="mono">{result.jwks_keys ?? 0}</code>
        </div>
      </div>
    );
  }
  return (
    <div className="text-xs rounded border border-danger/40 bg-danger/5 px-3 py-2">
      <div className="text-danger font-medium">Connection failed</div>
      <div className="text-muted mt-1">{result.error ?? "unknown error"}</div>
    </div>
  );
}

function ProviderSummary({
  provider,
  roles,
}: {
  provider: SsoProviderConfig;
  roles: Role[];
}) {
  const roleNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of roles) m[r.id] = r.name;
    return m;
  }, [roles]);
  const mappingEntries = Object.entries(provider.role_mappings);
  return (
    <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
      <Field label="Kind">{provider.kind}</Field>
      <Field label="Client ID">
        <code className="mono">{provider.client_id ?? "—"}</code>
      </Field>
      <Field label="Client secret">
        {provider.client_secret ? (
          <span className="text-muted">configured (***)</span>
        ) : (
          <span className="text-muted/60">unset</span>
        )}
      </Field>
      <Field label="Redirect URI">
        <code className="mono">{provider.redirect_uri ?? "—"}</code>
      </Field>
      <Field label="Scopes">
        <code className="mono">{provider.scopes.join(" ")}</code>
      </Field>
      <Field label="Groups claim">
        <code className="mono">{provider.groups_claim}</code>
      </Field>
      <div className="sm:col-span-2 space-y-1">
        <div className="text-muted">Group → Role mappings</div>
        {mappingEntries.length === 0 ? (
          <div className="text-muted/60">
            No mappings configured — sign-ins will be rejected with{" "}
            <code className="mono">no_groups_assigned</code>.
          </div>
        ) : (
          <div className="space-y-1">
            {mappingEntries.map(([group, roleIds]) => (
              <div key={group} className="flex items-center gap-2">
                <code className="mono text-muted">{group}</code>
                <span className="text-muted/60">→</span>
                <div className="flex flex-wrap gap-1">
                  {roleIds.map((rid) => (
                    <span
                      key={rid}
                      className="rounded bg-border/40 px-1.5 py-0.5 text-[11px]"
                    >
                      {roleNameById[rid] ?? rid}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

interface MappingDraft {
  group: string;
  roleId: string;
}

function ProviderEditor({
  mode,
  provider,
  roles,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  provider: SsoProviderConfig | null;
  roles: Role[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const initialMappings: MappingDraft[] = useMemo(() => {
    if (!provider) return [];
    const out: MappingDraft[] = [];
    for (const [group, roleIds] of Object.entries(provider.role_mappings)) {
      // The API stores group→[roleId,...]; we flatten to one row per
      // (group, role) pair so the editor stays simple.
      for (const rid of roleIds) {
        out.push({ group, roleId: rid });
      }
    }
    return out;
  }, [provider]);

  const [id, setId] = useState(provider?.id ?? "");
  const [displayName, setDisplayName] = useState(provider?.display_name ?? "");
  const [issuer, setIssuer] = useState(provider?.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(provider?.redirect_uri ?? "");
  const [scopes, setScopes] = useState(
    (provider?.scopes ?? ["openid", "email", "profile"]).join(" "),
  );
  const [groupsClaim, setGroupsClaim] = useState(provider?.groups_claim ?? "groups");
  const [mappings, setMappings] = useState<MappingDraft[]>(
    initialMappings.length ? initialMappings : [{ group: "", roleId: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setMapping(idx: number, patch: Partial<MappingDraft>) {
    setMappings((cur) =>
      cur.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  }
  function removeMapping(idx: number) {
    setMappings((cur) => cur.filter((_, i) => i !== idx));
  }
  function addMapping() {
    setMappings((cur) => [...cur, { group: "", roleId: "" }]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    // Build the role_mappings record — group → [role_id, ...]. The
    // server stores ids; the dropdown above already shows names so
    // the operator picks by name. Multiple rows with the same group
    // collapse into a single key with the union of their role_ids.
    const role_mappings: Record<string, string[]> = {};
    for (const row of mappings) {
      const g = row.group.trim();
      const rid = row.roleId.trim();
      if (!g || !rid) continue;
      const set = role_mappings[g] ?? [];
      if (!set.includes(rid)) set.push(rid);
      role_mappings[g] = set;
    }

    const body: SsoProviderInput = {
      display_name: displayName.trim() || undefined,
      issuer: issuer.trim() || undefined,
      client_id: clientId.trim() || undefined,
      // Empty string == "leave existing secret untouched" on PATCH.
      // On CREATE we must require a secret; the server enforces this.
      client_secret: clientSecret.trim() || undefined,
      redirect_uri: redirectUri.trim() || undefined,
      scopes: scopes
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
      groups_claim: groupsClaim.trim() || undefined,
      role_mappings,
    };

    try {
      if (mode === "create") {
        if (!id.trim()) {
          setError("ID is required.");
          setBusy(false);
          return;
        }
        body.id = id.trim();
        body.kind = "oidc";
        await createSsoProvider(body);
        toast.success("Provider created.");
      } else if (provider) {
        await updateSsoProvider(provider.id, body);
        toast.success(
          provider.source === "yaml"
            ? "Provider override saved. The YAML row is now shadowed by your edits."
            : "Provider updated.",
        );
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-6 space-y-4 mt-2">
      <div className="text-sm font-semibold">
        {mode === "create" ? "New identity provider" : `Edit ${provider?.display_name}`}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-xs text-muted block">ID (slug)</label>
          <input
            className="input mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="keycloak"
            disabled={mode === "edit"}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block">Display name</label>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Keycloak"
            required={mode === "create"}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs text-muted block">Issuer URL</label>
          <input
            className="input mono"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://kc.example.com/realms/fleet"
            required={mode === "create"}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block">Client ID</label>
          <input
            className="input mono"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            required={mode === "create"}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block">
            Client secret{" "}
            {mode === "edit" && (
              <span className="text-muted/60">(leave blank to keep)</span>
            )}
          </label>
          <input
            type="password"
            className="input mono"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={mode === "edit" ? "***" : ""}
            autoComplete="off"
            required={mode === "create"}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label className="text-xs text-muted block">Redirect URI</label>
          <input
            className="input mono"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="https://fleet.example.com/auth/sso/callback/keycloak"
            required={mode === "create"}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block">
            Scopes (space-separated)
          </label>
          <input
            className="input mono"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            placeholder="openid email profile groups"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted block">
            Groups claim path (dot-separated for nested)
          </label>
          <input
            className="input mono"
            value={groupsClaim}
            onChange={(e) => setGroupsClaim(e.target.value)}
            placeholder="groups"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-muted">Group → Role mappings</div>
        <p className="text-[11px] text-muted/70">
          Each row maps an IdP group claim value to a fleet role. Sign-ins
          for a user with no matching group are rejected — at least one
          mapping is required for any user to sign in.
        </p>
        <div className="space-y-1.5">
          {mappings.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className="input mono"
                placeholder="/fleet-admins"
                value={row.group}
                onChange={(e) => setMapping(idx, { group: e.target.value })}
              />
              <span className="text-muted">→</span>
              <select
                className="input"
                value={row.roleId}
                onChange={(e) => setMapping(idx, { roleId: e.target.value })}
              >
                <option value="">(pick a role)</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => removeMapping(idx)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn text-xs" onClick={addMapping}>
          + Add mapping
        </button>
      </div>

      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex gap-2 justify-end pt-2">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}
