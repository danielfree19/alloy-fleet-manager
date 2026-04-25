/**
 * API token create / verify / revoke.
 *
 * Tokens are long-lived bearer credentials owned by a user. Format:
 *
 *   fmt_<prefix>_<secret>
 *   ───  ────────  ──────
 *    │       │        └── 32 random bytes, base64url, never persisted
 *    │       └── first 8 chars (also stored as token_prefix for display)
 *    └── fixed marker so leaked tokens are easy to grep for
 *
 * Persistence: only `token_prefix` and `sha256(full_token)` are stored.
 * The plaintext token is shown to the user exactly once at creation
 * time and never again — same model as GitHub PATs, AWS access keys,
 * etc.
 *
 * Verification: presented bearer must (a) match the marker prefix
 * format, (b) have its sha256 equal one of the active rows. We use
 * the token_prefix as a cheap index lookup before the constant-time
 * hash compare.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { DbPool } from "../db/pool.js";
import type { Permission } from "./permissions.js";
import { isPermission } from "./permissions.js";

const TOKEN_MARKER = "fmt_";
const PREFIX_LEN = 8;

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiTokenWithRoles extends ApiTokenRow {
  roles: { id: string; name: string }[];
}

/**
 * Generate a new token. Returns the plaintext token (to show the user
 * once) and the row that was inserted. The row never carries the
 * plaintext.
 */
export async function createApiToken(
  runner: DbPool | PoolClient,
  input: {
    user_id: string;
    name: string;
    expires_at?: Date | null;
    role_ids?: string[];
  },
): Promise<{ token: string; row: ApiTokenRow }> {
  // Generate the secret first; if we generated the prefix and
  // separately the secret we'd risk a prefix collision unique-violation
  // on insert. Combining them means the prefix is derived from the
  // already-random secret bytes, so collision is 1 in 2^48.
  const secret = randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, PREFIX_LEN);
  const fullToken = `${TOKEN_MARKER}${prefix}_${secret.slice(PREFIX_LEN)}`;
  const tokenHash = createHash("sha256").update(fullToken, "utf8").digest("hex");

  const r = await runner.query<ApiTokenRow>(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, name, token_prefix, expires_at, revoked_at,
                 last_used_at, created_at`,
    [
      input.user_id,
      input.name,
      prefix,
      tokenHash,
      input.expires_at ? input.expires_at.toISOString() : null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error("INSERT api_tokens returned no row");

  if (input.role_ids && input.role_ids.length > 0) {
    await setApiTokenRoles(runner, row.id, input.role_ids);
  }

  return { token: fullToken, row };
}

export async function setApiTokenRoles(
  runner: DbPool | PoolClient,
  apiTokenId: string,
  roleIds: string[],
): Promise<void> {
  await runner.query(`DELETE FROM api_token_roles WHERE api_token_id = $1`, [apiTokenId]);
  for (const rid of roleIds) {
    await runner.query(
      `INSERT INTO api_token_roles (api_token_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [apiTokenId, rid],
    );
  }
}

/**
 * Look up by presented bearer string. Returns null when:
 *   - format doesn't match,
 *   - prefix isn't found,
 *   - hash doesn't match (timing-safe compare),
 *   - token is revoked or expired.
 *
 * On success bumps `last_used_at` (best effort).
 */
export async function verifyApiToken(
  runner: DbPool | PoolClient,
  presented: string,
): Promise<ApiTokenRow | null> {
  if (!presented.startsWith(TOKEN_MARKER)) return null;
  const rest = presented.slice(TOKEN_MARKER.length);
  const sep = rest.indexOf("_");
  if (sep !== PREFIX_LEN) return null;
  const prefix = rest.slice(0, PREFIX_LEN);
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) return null;

  const r = await runner.query<ApiTokenRow & { token_hash: string }>(
    `SELECT id, user_id, name, token_prefix, token_hash, expires_at,
            revoked_at, last_used_at, created_at
       FROM api_tokens WHERE token_prefix = $1`,
    [prefix],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  const presentedHash = createHash("sha256").update(presented, "utf8").digest("hex");
  // timingSafeEqual requires equal-length buffers and throws otherwise.
  // Equal hex length is guaranteed (sha256 = 64 hex chars), but guard
  // anyway.
  const a = Buffer.from(presentedHash, "utf8");
  const b = Buffer.from(row.token_hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Bump last_used_at out-of-band; do not block the auth path on it.
  void runner
    .query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {
      // intentionally ignored — auth already succeeded.
    });

  // Strip the hash before returning so it never leaves this module.
  const { token_hash: _ignored, ...safe } = row;
  void _ignored;
  return safe;
}

export async function listApiTokens(
  runner: DbPool | PoolClient,
  filter: { user_id?: string } = {},
): Promise<ApiTokenWithRoles[]> {
  const where = filter.user_id ? `WHERE t.user_id = $1` : ``;
  const params = filter.user_id ? [filter.user_id] : [];
  const r = await runner.query<
    ApiTokenRow & { role_id: string | null; role_name: string | null }
  >(
    `SELECT t.id, t.user_id, t.name, t.token_prefix, t.expires_at,
            t.revoked_at, t.last_used_at, t.created_at,
            r.id   AS role_id,
            r.name AS role_name
       FROM api_tokens t
       LEFT JOIN api_token_roles tr ON tr.api_token_id = t.id
       LEFT JOIN roles r ON r.id = tr.role_id
       ${where}
       ORDER BY t.created_at DESC, t.id, r.name`,
    params,
  );
  // Group rows by token id.
  const byId = new Map<string, ApiTokenWithRoles>();
  for (const row of r.rows) {
    const existing = byId.get(row.id);
    if (existing) {
      if (row.role_id && row.role_name) {
        existing.roles.push({ id: row.role_id, name: row.role_name });
      }
      continue;
    }
    byId.set(row.id, {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      token_prefix: row.token_prefix,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
      roles: row.role_id && row.role_name ? [{ id: row.role_id, name: row.role_name }] : [],
    });
  }
  return Array.from(byId.values());
}

export async function findApiTokenById(
  runner: DbPool | PoolClient,
  id: string,
): Promise<ApiTokenRow | null> {
  const r = await runner.query<ApiTokenRow>(
    `SELECT id, user_id, name, token_prefix, expires_at, revoked_at,
            last_used_at, created_at
       FROM api_tokens WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * Revoke (soft-delete) a token. We keep the row around so audit
 * events that reference it can still resolve the prefix and name —
 * the alternative (hard delete) would orphan FK references.
 */
export async function revokeApiToken(
  runner: DbPool | PoolClient,
  id: string,
): Promise<boolean> {
  const r = await runner.query(
    `UPDATE api_tokens SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Materialize the union of every permission granted to this token
 * across its assigned roles. Mirrors `loadUserPermissions` for users.
 */
export async function loadApiTokenPermissions(
  runner: DbPool | PoolClient,
  apiTokenId: string,
): Promise<Set<Permission>> {
  const r = await runner.query<{ permission: string }>(
    `SELECT DISTINCT rp.permission
       FROM api_token_roles tr
       JOIN role_permissions rp ON rp.role_id = tr.role_id
       WHERE tr.api_token_id = $1`,
    [apiTokenId],
  );
  const set = new Set<Permission>();
  for (const row of r.rows) {
    if (isPermission(row.permission)) set.add(row.permission);
  }
  return set;
}
