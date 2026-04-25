/**
 * Bootstrap helper: ensure there is at least one admin user.
 *
 * Runs once at server startup. If the `users` table is empty AND
 * `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` are set, we
 * create that user with the built-in `admin` role.
 *
 * The "empty users" check matters: re-running the bootstrap on a
 * deployment that already has users would either create duplicates
 * (if the email differed) or be a no-op (if it didn't). We chose
 * "skip silently if any users exist" because it's idempotent and
 * surprises nobody.
 *
 * If no users exist and bootstrap creds are not set, we log a
 * one-line warning. Operators can then either:
 *   (a) set the env vars and restart, or
 *   (b) use ADMIN_TOKEN as a Bearer to POST /users themselves.
 */
import type { FastifyBaseLogger } from "fastify";
import type { DbPool } from "../db/pool.js";
import { createUser, findRoleByName, setUserRoles } from "./users.js";

export async function bootstrapFirstAdmin(
  db: DbPool,
  log: FastifyBaseLogger,
  envEmail: string | undefined,
  envPassword: string | undefined,
): Promise<void> {
  const c = await db.query<{ count: string }>(`SELECT COUNT(*)::text FROM users`);
  const count = parseInt(c.rows[0]?.count ?? "0", 10);
  if (count > 0) return;

  if (!envEmail || !envPassword) {
    log.warn(
      "no users exist and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set — " +
        "use ADMIN_TOKEN to POST /users, or restart with the bootstrap env vars set",
    );
    return;
  }

  const adminRole = await findRoleByName(db, "admin");
  if (!adminRole) {
    // Built-in roles are seeded by the migration. If we get here the
    // migration didn't run successfully — bail loudly.
    throw new Error(
      "bootstrap: built-in 'admin' role missing. Did the identity migration run?",
    );
  }

  const user = await createUser(db, {
    email: envEmail,
    name: "Bootstrap Admin",
    password: envPassword,
  });
  await setUserRoles(db, user.id, [adminRole.id]);

  log.warn(
    { email: envEmail },
    "BOOTSTRAP: created first admin user. Sign in via the UI, " +
      "create per-user accounts, then unset BOOTSTRAP_ADMIN_PASSWORD " +
      "(it's a no-op once any user exists, but rotate the value anyway).",
  );
}
