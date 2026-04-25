-- Up Migration
-- Per-account lockout columns for the login flow.
--
-- The login route already runs bcrypt at cost factor 12 (~250ms) which
-- is mild brute-force friction but doesn't stop a slow credential
-- stuffer with a large list. Add per-account state so that after N
-- failed attempts a user is locked out for a fixed window.
--
-- Both columns are intentionally additive — nothing pre-existing is
-- altered, so this migration is safe to run on a deployment with live
-- users. New columns default to "no failures, not locked", which is
-- the same observable behavior as today.
--
-- The actual policy (threshold count, lockout duration) lives in code
-- (auth/users.ts) so operators can tune it via env without a schema
-- change.

ALTER TABLE users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until       timestamptz;

-- Down Migration
ALTER TABLE users
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS failed_login_count;
