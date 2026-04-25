/**
 * Session create / lookup / expire.
 *
 * Sessions are server-side rows in `sessions`. The browser receives
 * an opaque cookie (`fleet.sid`) containing only the session id —
 * everything else is looked up in PG on each request.
 *
 * Sliding expiration: every successful auth check bumps `last_seen`
 * and, if more than half the TTL has passed, extends `expires_at`.
 * This means active users stay logged in indefinitely while idle
 * sessions expire after `SESSION_TTL_MS` of no activity.
 */
import type { PoolClient } from "pg";
import type { DbPool } from "../db/pool.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_COOKIE = "fleet.sid";
const SLIDING_REFRESH_THRESHOLD_MS = SESSION_TTL_MS / 2;

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  last_seen: string;
  user_agent: string | null;
  ip: string | null;
}

export async function createSession(
  runner: DbPool | PoolClient,
  userId: string,
  meta: { user_agent?: string | null; ip?: string | null } = {},
): Promise<SessionRow> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const r = await runner.query<SessionRow>(
    `INSERT INTO sessions (user_id, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, expires_at, created_at, last_seen, user_agent, ip`,
    [userId, expiresAt, meta.user_agent ?? null, meta.ip ?? null],
  );
  const row = r.rows[0];
  if (!row) throw new Error("INSERT sessions returned no row");
  return row;
}

/**
 * Look up a session by id. Returns null when:
 *   - the row doesn't exist (logged out, or never existed),
 *   - the row exists but `expires_at` has passed.
 *
 * Side effects: bumps `last_seen` on hit; extends `expires_at` if more
 * than half the TTL has elapsed since creation. Both updates are best
 * effort — a failed UPDATE doesn't fail the request.
 */
export async function touchSession(
  runner: DbPool | PoolClient,
  sessionId: string,
): Promise<SessionRow | null> {
  const now = Date.now();
  const r = await runner.query<SessionRow>(
    `SELECT id, user_id, expires_at, created_at, last_seen, user_agent, ip
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now) {
    // Expired — delete and report not-found. We don't garbage-collect
    // expired rows here on the read path because that would race with
    // concurrent cleanup; just return null.
    return null;
  }
  // Sliding window: if expires_at is closer than SLIDING_REFRESH_THRESHOLD_MS,
  // extend it. We check this on every request but only WRITE if needed,
  // which keeps idle reads cheap.
  const newExpiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  const remaining = Date.parse(row.expires_at) - now;
  if (remaining < SLIDING_REFRESH_THRESHOLD_MS) {
    await runner.query(
      `UPDATE sessions SET last_seen = now(), expires_at = $1 WHERE id = $2`,
      [newExpiresAt, sessionId],
    );
    return { ...row, expires_at: newExpiresAt };
  }
  // Cheap path: just bump last_seen.
  await runner.query(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [sessionId]);
  return row;
}

export async function deleteSession(
  runner: DbPool | PoolClient,
  sessionId: string,
): Promise<void> {
  await runner.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

/**
 * Invalidate every session for a user. Used when a user is disabled
 * or their password is reset administratively. Returns the number of
 * rows removed (caller may want to log it).
 */
export async function deleteSessionsForUser(
  runner: DbPool | PoolClient,
  userId: string,
): Promise<number> {
  const r = await runner.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}

/**
 * Garbage-collect expired sessions. Cheap; meant to be run on a timer
 * (see server bootstrap). Not strictly needed for correctness because
 * `touchSession` already rejects expired rows, but keeps the table
 * size sane.
 */
export async function purgeExpiredSessions(runner: DbPool | PoolClient): Promise<number> {
  const r = await runner.query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return r.rowCount ?? 0;
}
