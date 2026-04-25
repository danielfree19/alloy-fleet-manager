/**
 * Canonical permission catalog.
 *
 * Permissions are opaque strings stored in `role_permissions.permission`
 * (see migration 1700000000003_identity.sql). The set of valid strings
 * lives here in code — adding a new permission is a code change, not a
 * schema change.
 *
 * Naming convention: `<resource>.<verb>`.
 *   - `read`   — list/get
 *   - `create` — POST a new row
 *   - `update` — PATCH/PUT an existing row
 *   - `delete` — DELETE
 *   - `write`  — admin/management ops (used for users, tokens, roles
 *                where the create/update/delete distinction would be
 *                more pedantic than useful)
 *
 * The split between `pipelines.create` and `pipelines.update` was an
 * explicit choice (see docs/auth.md) — it lets you mint roles that
 * can edit existing pipelines but can't create new ones.
 *
 * The legacy ADMIN_TOKEN env var resolves to a synthetic actor with
 * EVERY permission (see auth/middleware.ts). It's the documented
 * break-glass path; we don't model it as a row in the DB.
 */

export const ALL_PERMISSIONS = [
  // ---- pipelines ----------------------------------------------------------
  "pipelines.read",
  "pipelines.create",
  "pipelines.update",
  "pipelines.delete",

  // ---- collectors ---------------------------------------------------------
  // `collectors.read` — list collectors + view their assembled configs (UI/admin)
  // `collectors.poll` — call the remotecfg RPC endpoints
  //                     (POST /collector.v1.CollectorService/{GetConfig,Register,
  //                     UnregisterCollector}). This is the permission an Alloy
  //                     instance needs. Granted by the built-in `agent` role.
  "collectors.read",
  "collectors.poll",

  // ---- catalog (always read-only at the API layer) ------------------------
  "catalog.read",

  // ---- audit log ----------------------------------------------------------
  "audit.read",

  // ---- identity & access management ---------------------------------------
  // `users.read`  — list users + their roles
  // `users.write` — create/edit/disable users, assign roles, reset passwords,
  //                 manage other users' API tokens, create/edit custom roles
  "users.read",
  "users.write",

  // ---- API tokens ---------------------------------------------------------
  // `tokens.read`  — list ALL users' tokens (own tokens are always listable
  //                  without this permission)
  // `tokens.write` — create/revoke OTHER users' tokens (own-token management
  //                  is always allowed)
  "tokens.read",
  "tokens.write",

  // ---- SSO / identity providers (Phase 2) ---------------------------------
  // `sso.read`  — view IdP configuration + SSO activity (audited rejections,
  //               sign-ins). Read-only. Does NOT permit testing connections
  //               that involve writes (we kept connection tests under
  //               sso.read explicitly so an auditor can verify a YAML-only
  //               provider works without being able to mutate it).
  // `sso.write` — CRUD identity_providers, edit role mappings, link/unlink
  //               an SSO identity to a local user, run connection tests.
  "sso.read",
  "sso.write",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(s: unknown): s is Permission {
  return typeof s === "string" && PERMISSION_SET.has(s);
}

/**
 * The resolved caller for a request. Populated by the auth middleware
 * onto `request.actor`. Every admin route should consult this for both
 * authorization (the `permissions` set) and audit attribution
 * (everything else).
 *
 * `kind`:
 *   - `env_token` — legacy ADMIN_TOKEN env var. `userId` is null.
 *                   `permissions` is the FULL set.
 *   - `user`      — interactive browser session (cookie auth).
 *   - `api_token` — programmatic Bearer token from `api_tokens`.
 *
 * `permissions` is always the materialized permission set for this
 * actor — for users it's the union of all their roles; for api_tokens
 * it's the union of the token's roles (which is a subset of the
 * owner's). Keeping it pre-resolved means every route's permission
 * check is one Set.has() call.
 */
export interface Actor {
  kind: "env_token" | "user" | "api_token";
  /** Null only for `env_token` (no row in `users`). */
  userId: string | null;
  /** Null for `env_token`. */
  email: string | null;
  /** Null for `env_token`. */
  name: string | null;
  /** Set only when kind === "api_token". */
  apiTokenId: string | null;
  /** Materialized union of every role's permissions. */
  permissions: ReadonlySet<Permission>;
}

export function actorHasPermission(actor: Actor, p: Permission): boolean {
  return actor.permissions.has(p);
}

/**
 * Build the synthetic actor that represents the legacy `ADMIN_TOKEN`
 * env var. Used by the auth middleware when a request presents the
 * env token rather than a DB-backed bearer.
 */
export function envTokenActor(): Actor {
  return {
    kind: "env_token",
    userId: null,
    email: null,
    name: null,
    apiTokenId: null,
    permissions: new Set<Permission>(ALL_PERMISSIONS),
  };
}

/**
 * Short, stable, non-reversible string identifying the caller for
 * audit log inserts. Mirrors the historical `audit_events.actor`
 * format so existing rows + queries keep working.
 */
export function actorAuditString(actor: Actor): string {
  switch (actor.kind) {
    case "env_token":
      return "admin-token:env";
    case "user":
      return `user:${actor.email ?? actor.userId ?? "unknown"}`;
    case "api_token":
      return `api-token:${actor.apiTokenId ?? "unknown"}`;
  }
}
