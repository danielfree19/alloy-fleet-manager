/**
 * User and role queries.
 *
 * Everything that touches the `users`, `roles`, `role_permissions`,
 * and `user_roles` tables routes through this module. Two reasons to
 * centralize:
 *   1. Email normalization (lowercase) happens in exactly one place.
 *   2. `loadUserPermissions` is the canonical "what can this user do?"
 *      query, used by both the auth middleware and the admin UI's
 *      role-display helpers.
 *
 * None of these helpers do permission checks — the route layer is
 * responsible for that. They're pure data access.
 */

import type { PoolClient } from "pg";
import type { DbPool } from "../db/pool.js";
import { hashPassword } from "./passwords.js";
import { isPermission, type Permission } from "./permissions.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  disabled: boolean;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Lockout policy. Five consecutive failures lock the account for 15
 * minutes. The threshold is intentionally low because the bcrypt cost
 * factor already gates raw throughput; the lockout exists to defeat
 * a slow stuffer with a large list, not to harden against single-target
 * dictionary attack (which the password policy itself does).
 */
export const LOGIN_FAILURE_LOCK_THRESHOLD = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  created_at: string;
}

/** Lowercased lookup; never trust caller-supplied casing. */
export async function findUserByEmail(
  runner: DbPool | PoolClient,
  email: string,
): Promise<UserRow | null> {
  const r = await runner.query<UserRow>(
    `SELECT id, email, name, password_hash, oidc_issuer, oidc_subject,
            disabled, failed_login_count, locked_until, created_at, updated_at
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return r.rows[0] ?? null;
}

export async function findUserById(
  runner: DbPool | PoolClient,
  id: string,
): Promise<UserRow | null> {
  const r = await runner.query<UserRow>(
    `SELECT id, email, name, password_hash, oidc_issuer, oidc_subject,
            disabled, failed_login_count, locked_until, created_at, updated_at
       FROM users WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function listUsers(runner: DbPool | PoolClient): Promise<UserRow[]> {
  const r = await runner.query<UserRow>(
    `SELECT id, email, name, password_hash, oidc_issuer, oidc_subject,
            disabled, failed_login_count, locked_until, created_at, updated_at
       FROM users
       ORDER BY lower(email)`,
  );
  return r.rows;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password?: string | null;
  roleIds?: string[];
}

export async function createUser(
  runner: DbPool | PoolClient,
  input: CreateUserInput,
): Promise<UserRow> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const r = await runner.query<UserRow>(
    `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, password_hash, oidc_issuer, oidc_subject,
                 disabled, failed_login_count, locked_until, created_at, updated_at`,
    [input.email.trim(), input.name ?? null, passwordHash],
  );
  const user = r.rows[0];
  if (!user) throw new Error("INSERT users returned no row");
  if (input.roleIds && input.roleIds.length > 0) {
    await setUserRoles(runner, user.id, input.roleIds);
  }
  return user;
}

export interface UpdateUserInput {
  name?: string | null;
  disabled?: boolean;
}

export async function updateUser(
  runner: DbPool | PoolClient,
  id: string,
  patch: UpdateUserInput,
): Promise<UserRow | null> {
  // Build a dynamic SET clause so unspecified fields aren't NULLed.
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.disabled !== undefined) {
    params.push(patch.disabled);
    sets.push(`disabled = $${params.length}`);
  }
  params.push(id);
  const r = await runner.query<UserRow>(
    `UPDATE users SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING id, email, name, password_hash, oidc_issuer, oidc_subject,
                  disabled, failed_login_count, locked_until, created_at, updated_at`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function setPassword(
  runner: DbPool | PoolClient,
  id: string,
  newPlain: string,
): Promise<void> {
  const hash = await hashPassword(newPlain);
  await runner.query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [hash, id],
  );
}

export async function deleteUser(
  runner: DbPool | PoolClient,
  id: string,
): Promise<boolean> {
  const r = await runner.query(`DELETE FROM users WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function listRoles(runner: DbPool | PoolClient): Promise<RoleRow[]> {
  const r = await runner.query<RoleRow>(
    `SELECT id, name, description, builtin, created_at
       FROM roles ORDER BY builtin DESC, name`,
  );
  return r.rows;
}

export async function findRoleById(
  runner: DbPool | PoolClient,
  id: string,
): Promise<RoleRow | null> {
  const r = await runner.query<RoleRow>(
    `SELECT id, name, description, builtin, created_at
       FROM roles WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function findRoleByName(
  runner: DbPool | PoolClient,
  name: string,
): Promise<RoleRow | null> {
  const r = await runner.query<RoleRow>(
    `SELECT id, name, description, builtin, created_at
       FROM roles WHERE name = $1`,
    [name],
  );
  return r.rows[0] ?? null;
}

export async function listRolePermissions(
  runner: DbPool | PoolClient,
  roleId: string,
): Promise<Permission[]> {
  const r = await runner.query<{ permission: string }>(
    `SELECT permission FROM role_permissions WHERE role_id = $1`,
    [roleId],
  );
  // Filter to known permissions; tolerate (but ignore) any rogue rows
  // in case a future migration adds something this build doesn't know.
  return r.rows.map((x) => x.permission).filter(isPermission);
}

export async function setRolePermissions(
  runner: DbPool | PoolClient,
  roleId: string,
  perms: Permission[],
): Promise<void> {
  // Replace strategy: delete all, re-insert. Cheap because role
  // membership is small (≤ 11 rows in our model).
  await runner.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  for (const p of perms) {
    await runner.query(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [roleId, p],
    );
  }
}

export async function createCustomRole(
  runner: DbPool | PoolClient,
  name: string,
  description: string,
  perms: Permission[],
): Promise<RoleRow> {
  const r = await runner.query<RoleRow>(
    `INSERT INTO roles (name, description, builtin)
       VALUES ($1, $2, false)
       RETURNING id, name, description, builtin, created_at`,
    [name, description],
  );
  const role = r.rows[0];
  if (!role) throw new Error("INSERT roles returned no row");
  await setRolePermissions(runner, role.id, perms);
  return role;
}

export async function deleteCustomRole(
  runner: DbPool | PoolClient,
  id: string,
): Promise<boolean> {
  const r = await runner.query(
    `DELETE FROM roles WHERE id = $1 AND builtin = false`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// User <-> role assignments
// ---------------------------------------------------------------------------

export async function listUserRoles(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<RoleRow[]> {
  const r = await runner.query<RoleRow>(
    `SELECT r.id, r.name, r.description, r.builtin, r.created_at
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1
       ORDER BY r.builtin DESC, r.name`,
    [userId],
  );
  return r.rows;
}

/**
 * Count active (non-disabled) users that hold the built-in `admin` role.
 *
 * Used by the route layer to refuse operations that would leave the
 * system with zero administrators — disabling the last admin,
 * deleting them, or stripping their admin role.
 *
 * NOTE: `ADMIN_TOKEN` (the env break-glass) is intentionally NOT
 * counted here. It always works, but it lives outside the user table
 * and most operators don't realize that. Refusing to remove the last
 * DB-backed admin protects the common case; recovery via env token is
 * still possible if someone manages to do it anyway.
 */
export async function countActiveAdmins(
  runner: DbPool | PoolClient,
  options?: { excludeUserId?: string },
): Promise<number> {
  const exclude = options?.excludeUserId ?? null;
  const r = await runner.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'admin'
        AND r.builtin = true
        AND u.disabled = false
        AND ($1::uuid IS NULL OR u.id <> $1::uuid)`,
    [exclude],
  );
  return Number.parseInt(r.rows[0]?.count ?? "0", 10);
}

/**
 * Does this user currently hold the built-in `admin` role? Used by
 * the last-admin-lockout guard in the route layer.
 */
export async function userHasAdminRole(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<boolean> {
  const r = await runner.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.name = 'admin' AND r.builtin = true
     ) AS exists`,
    [userId],
  );
  return r.rows[0]?.exists ?? false;
}

export async function setUserRoles(
  runner: DbPool | PoolClient,
  userId: string,
  roleIds: string[],
): Promise<void> {
  await runner.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  for (const rid of roleIds) {
    await runner.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [userId, rid],
    );
  }
}

// ---------------------------------------------------------------------------
// OIDC / SSO helpers (Phase 2)
// ---------------------------------------------------------------------------
//
// Everything below is additive — none of the existing helpers above
// were touched. The Phase 1 routes (POST /users, password change,
// PATCH /users/:id) keep working unchanged; the new /auth/sso/* +
// /sso/providers* routes layer on top.
//
// Naming convention: every helper that's specific to the SSO codepath
// has "Oidc" in the name so a reader scanning this file can tell which
// surface a function belongs to. We intentionally don't push these to
// a separate users-oidc.ts because callers already import a bunch of
// helpers from this module and the fan-out would hurt readability.

/**
 * Look up a user by their canonical IdP key — `(issuer, subject)`.
 * Used as the FIRST resolution step on every SSO callback: a returning
 * user hits this and skips all the JIT logic.
 */
export async function findUserByOidcSubject(
  runner: DbPool | PoolClient,
  issuer: string,
  subject: string,
): Promise<UserRow | null> {
  const r = await runner.query<UserRow>(
    `SELECT id, email, name, password_hash, oidc_issuer, oidc_subject,
            disabled, failed_login_count, locked_until, created_at, updated_at
       FROM users
      WHERE oidc_issuer = $1 AND oidc_subject = $2`,
    [issuer, subject],
  );
  return r.rows[0] ?? null;
}

/**
 * Find a user by email, INCLUDING ones that already carry an OIDC
 * binding. Used by the email-collision check in the SSO callback:
 * if a local user exists with the same email but no `(issuer,
 * subject)`, we REJECT the sign-in (audited as
 * `email_collision_local_user`) and force an admin to explicitly
 * `link` the identity.
 */
export async function findUserByEmailIncludingOidc(
  runner: DbPool | PoolClient,
  email: string,
): Promise<UserRow | null> {
  // For now this is identical to findUserByEmail — we keep the
  // separate name as a contract: anyone reading the SSO callback can
  // tell at the call site that "yes, OIDC users are intentionally
  // included in this lookup". If Phase N adds a separate sso_users
  // table this is the call site that splits.
  return findUserByEmail(runner, email);
}

/**
 * Provision a new SSO user. Called by the SSO callback on first
 * successful sign-in by a user whose group claim mapped to ≥ 1 role.
 * We do NOT persist a password_hash — these users authenticate only
 * via the IdP. Role assignments are passed in `roleIds`.
 *
 * Throws on email-uniqueness violation (Postgres 23505); the caller
 * is expected to have already done the collision check, so a 23505
 * here is a logic bug worth surfacing.
 */
export interface CreateOidcUserInput {
  email: string;
  name: string | null;
  oidc_issuer: string;
  oidc_subject: string;
  roleIds: string[];
}

export async function createOidcUser(
  runner: DbPool | PoolClient,
  input: CreateOidcUserInput,
): Promise<UserRow> {
  const r = await runner.query<UserRow>(
    `INSERT INTO users (email, name, password_hash, oidc_issuer, oidc_subject)
       VALUES ($1, $2, NULL, $3, $4)
       RETURNING id, email, name, password_hash, oidc_issuer, oidc_subject,
                 disabled, failed_login_count, locked_until, created_at, updated_at`,
    [input.email.trim(), input.name, input.oidc_issuer, input.oidc_subject],
  );
  const user = r.rows[0];
  if (!user) throw new Error("INSERT users (oidc) returned no row");
  if (input.roleIds.length > 0) {
    await setUserRoles(runner, user.id, input.roleIds);
  }
  return user;
}

/**
 * Replace this user's role assignments with `roleIds`. Returns a diff
 * summary `{ added, removed }` so the caller can decide whether to
 * audit a `auth.sso.role_sync` event (we only emit it on actual
 * change to keep noise down).
 *
 * IMPORTANT: this helper does NOT enforce the last-active-admin
 * lockout. The SSO callback caller is expected to skip the sync (or
 * fall back to the prior role set) when stripping admin would cause
 * lockout — see the route for the policy.
 */
export async function syncUserRolesForOidc(
  runner: DbPool | PoolClient,
  userId: string,
  roleIds: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const before = await listUserRoles(runner, userId);
  const beforeIds = new Set(before.map((r) => r.id));
  const afterIds = new Set(roleIds);
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  if (added.length === 0 && removed.length === 0) {
    return { added: [], removed: [] };
  }
  await setUserRoles(runner, userId, roleIds);
  return { added, removed };
}

/**
 * Bind a local user to a specific (issuer, subject). Used by the
 * "Link to SSO" admin action so an existing email/password user can
 * keep their UUID, audit attribution, and api_tokens after the
 * organization adopts SSO. Refuses if either:
 *
 *   - the user already has an OIDC binding (caller must unlink first),
 *   - that (issuer, subject) is already bound to a different user
 *     (Postgres unique partial index on (oidc_issuer, oidc_subject)).
 *
 * The unique-violation is surfaced as a regular Postgres error from
 * the caller; we don't translate it here because the route layer
 * already turns 23505 into a 409.
 */
export async function linkLocalUserToSso(
  runner: DbPool | PoolClient,
  userId: string,
  issuer: string,
  subject: string,
): Promise<UserRow | null> {
  const r = await runner.query<UserRow>(
    `UPDATE users
        SET oidc_issuer = $2,
            oidc_subject = $3,
            updated_at = now()
      WHERE id = $1
        AND oidc_issuer IS NULL
        AND oidc_subject IS NULL
      RETURNING id, email, name, password_hash, oidc_issuer, oidc_subject,
                disabled, failed_login_count, locked_until, created_at, updated_at`,
    [userId, issuer, subject],
  );
  return r.rows[0] ?? null;
}

/**
 * Drop a user's SSO binding. They keep their roles + audit history
 * but cannot sign in via the IdP anymore — they fall back to local
 * password auth (if a hash is set; admin can also Reset Password to
 * regrant access).
 */
export async function unlinkUserSso(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<UserRow | null> {
  const r = await runner.query<UserRow>(
    `UPDATE users
        SET oidc_issuer = NULL,
            oidc_subject = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING id, email, name, password_hash, oidc_issuer, oidc_subject,
                disabled, failed_login_count, locked_until, created_at, updated_at`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * Materialize the union of every permission granted to this user
 * across all their roles. This is the canonical "what can this user
 * do?" query — invoked on every authenticated request via the auth
 * middleware. We keep it a single SELECT DISTINCT for cache
 * friendliness.
 */
export async function loadUserPermissions(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<Set<Permission>> {
  const r = await runner.query<{ permission: string }>(
    `SELECT DISTINCT rp.permission
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1`,
    [userId],
  );
  const set = new Set<Permission>();
  for (const row of r.rows) {
    if (isPermission(row.permission)) set.add(row.permission);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Login lockout
// ---------------------------------------------------------------------------
//
// Three transitions, all driven from `routes/auth.ts`:
//
//   1. Successful password verify  → clearLoginFailures
//   2. Failed password verify      → recordLoginFailure
//        (which auto-locks once the count hits the threshold)
//   3. Admin "unlock"              → clearLoginFailures
//
// The check that decides whether to bcrypt-compare at all is
// `isAccountLocked(row)` — a pure helper that reads the row's
// `locked_until` field. We intentionally STILL run bcrypt for locked
// accounts on the route side, to keep the timing of "wrong password
// while locked" indistinguishable from "wrong password while unlocked".

export function isAccountLocked(user: Pick<UserRow, "locked_until">): boolean {
  if (!user.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}

/**
 * Increment the failure counter and lock the account if the threshold
 * is reached. Returns the post-update lock state so the route can pick
 * the right error code (423 vs 401) for the response.
 *
 * Single SQL statement so the threshold check + lock-stamp happens
 * atomically — without it, two near-simultaneous bad attempts could
 * leave the counter at threshold without ever stamping `locked_until`.
 */
export async function recordLoginFailure(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<{ locked: boolean; locked_until: string | null; failures: number }> {
  const r = await runner.query<{
    failed_login_count: number;
    locked_until: string | null;
  }>(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= $2
                THEN now() + ($3::int || ' milliseconds')::interval
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_login_count, locked_until`,
    [userId, LOGIN_FAILURE_LOCK_THRESHOLD, LOGIN_LOCK_DURATION_MS],
  );
  const row = r.rows[0];
  if (!row) return { locked: false, locked_until: null, failures: 0 };
  return {
    failures: row.failed_login_count,
    locked_until: row.locked_until,
    locked: row.locked_until !== null && new Date(row.locked_until).getTime() > Date.now(),
  };
}

/**
 * Clear the failure counter and any active lock. Called on successful
 * sign-in and from the admin unlock path. Idempotent.
 */
export async function clearLoginFailures(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<void> {
  await runner.query(
    `UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL
      WHERE id = $1`,
    [userId],
  );
}
