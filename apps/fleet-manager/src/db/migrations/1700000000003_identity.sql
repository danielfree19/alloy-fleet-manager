-- Up Migration
-- Identity, RBAC, sessions, and API tokens.
--
-- This migration introduces a real identity model on top of the existing
-- ADMIN_TOKEN env-var path. The env token is preserved as a "break-glass"
-- super-actor — see auth/middleware.ts for the resolution order. Nothing
-- in this migration changes the behavior of code paths that don't opt
-- into the new tables, so existing deployments keep working untouched.
--
-- Table relationships:
--
--   users        ─< user_roles >─ roles ─< role_permissions
--     │
--     ├─< sessions          (browser cookie auth)
--     │
--     └─< api_tokens ─< api_token_roles >─ roles
--                              ^
--                              └── tokens carry a SUBSET of their owner's
--                                  roles, so an admin can mint a
--                                  read-only CI token.
--
-- Permissions are NOT modeled as a table — the canonical list lives in
-- auth/permissions.ts. role_permissions stores them as opaque strings so
-- the migration doesn't need to know what permissions exist; adding a
-- new permission is a code change, not a schema change.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- A "user" is whoever can sign in via email + password (Phase 1) or via
-- OIDC (Phase 2; columns reserved here so Phase 2 doesn't need a new
-- migration).
--
-- `password_hash` is null when the user is OIDC-only. `oidc_subject` +
-- `oidc_issuer` together form the natural key from the IdP and are
-- nullable until OIDC ships — the unique constraint is partial so
-- multiple null rows don't collide.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  password_hash text,                  -- bcrypt; null = no local password (OIDC-only)
  oidc_issuer   text,                  -- reserved for Phase 2
  oidc_subject  text,                  -- reserved for Phase 2; (issuer, subject) is the IdP key
  disabled      bool NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Email is unique case-insensitively; lowercase before insert.
CREATE UNIQUE INDEX users_email_unique ON users ((lower(email)));

-- One row per IdP identity. NULLs are allowed (local users), but when
-- both columns are set the pair must be unique.
CREATE UNIQUE INDEX users_oidc_unique
  ON users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

-- ---------------------------------------------------------------------------
-- roles + permissions
-- ---------------------------------------------------------------------------
-- A role is a named bundle of permission strings. Three roles are
-- seeded as `builtin = true`: admin, editor, viewer. Built-ins cannot
-- be deleted or have their permission set edited via the API (the
-- routes layer enforces this). New custom roles are created with
-- `builtin = false`.

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  builtin     bool NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- (role_id, permission) — opaque strings so adding new permissions is
-- a code change. The set of valid permissions lives in
-- auth/permissions.ts; routes that accept a permission name validate
-- against it before insert.
CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Many-to-many user ↔ role.
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- Server-side session store. The browser receives an opaque cookie
-- containing only the session id; everything else is looked up in
-- this table on each request. We pick DB-backed sessions over JWT
-- cookies because:
--   1. Real logout / revocation works (delete the row).
--   2. We can list "all your active sessions" in the UI later.
--   3. We can attribute audit events to a specific browser/user pair.
-- The cost is one indexed lookup per request, which is negligible.

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          text
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- api_tokens
-- ---------------------------------------------------------------------------
-- Long-lived bearer tokens for programmatic access (CI, fleetctl, SDK).
-- Each token belongs to a user (so audit events can be attributed) and
-- carries an explicit subset of that user's roles.
--
-- Token format: "fmt_<prefix>_<secret>"
--   - "fmt_"  — fixed prefix so leaks are easy to grep for in logs.
--   - prefix  — 8 chars, stored in `token_prefix`, used for display
--               ("fmt_a1b2c3d4...") and as a fast lookup key.
--   - secret  — 32 random bytes base64url; only the sha256 of the FULL
--               token (prefix.secret) is persisted in `token_hash`.
--
-- Verification compares sha256(presented_token) to token_hash with a
-- timing-safe equality.

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,           -- human label, e.g. "ci-prod"
  token_prefix  text NOT NULL UNIQUE,    -- public identifier
  token_hash    text NOT NULL,           -- sha256 hex of the full token
  expires_at    timestamptz,             -- null = never expires
  revoked_at    timestamptz,             -- soft-delete; we keep rows for audit
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
CREATE INDEX api_tokens_active_idx
  ON api_tokens (token_prefix)
  WHERE revoked_at IS NULL;

CREATE TABLE api_token_roles (
  api_token_id uuid NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (api_token_id, role_id)
);

-- ---------------------------------------------------------------------------
-- audit_events: extend with structured actor columns
-- ---------------------------------------------------------------------------
-- The legacy `actor` text column stays put (back-compat for existing
-- rows + queries). We add new optional columns that the new auth
-- middleware populates — old rows simply have them all NULL.

ALTER TABLE audit_events
  ADD COLUMN actor_kind     text,             -- 'env_token' | 'user' | 'api_token' | 'oidc'
  ADD COLUMN actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN actor_email    text,             -- denormalized so audit survives user delete
  ADD COLUMN actor_token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL;

CREATE INDEX audit_events_actor_user_idx ON audit_events (actor_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed: built-in roles
-- ---------------------------------------------------------------------------
-- Permission strings here MUST stay in sync with auth/permissions.ts.
-- We use INSERT ... ON CONFLICT so re-running the migration on a DB
-- that already has these is a no-op.

INSERT INTO roles (id, name, description, builtin)
VALUES
  (gen_random_uuid(), 'admin',  'Full access to every resource and admin function.', true),
  (gen_random_uuid(), 'editor', 'Read everything; create/update/delete pipelines; manage own API tokens.', true),
  (gen_random_uuid(), 'viewer', 'Read-only access to pipelines, collectors, catalog, and audit log.', true)
ON CONFLICT (name) DO NOTHING;

-- admin: every permission
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p
FROM roles r,
     unnest(ARRAY[
       'pipelines.read',
       'pipelines.create',
       'pipelines.update',
       'pipelines.delete',
       'collectors.read',
       'catalog.read',
       'audit.read',
       'users.read',
       'users.write',
       'tokens.read',
       'tokens.write'
     ]) AS p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- editor: full pipeline lifecycle + reads + own tokens
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p
FROM roles r,
     unnest(ARRAY[
       'pipelines.read',
       'pipelines.create',
       'pipelines.update',
       'pipelines.delete',
       'collectors.read',
       'catalog.read',
       'audit.read'
     ]) AS p
WHERE r.name = 'editor'
ON CONFLICT DO NOTHING;

-- viewer: read-only everywhere
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p
FROM roles r,
     unnest(ARRAY[
       'pipelines.read',
       'collectors.read',
       'catalog.read',
       'audit.read'
     ]) AS p
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;

-- Down Migration
DROP INDEX IF EXISTS audit_events_actor_user_idx;
ALTER TABLE audit_events
  DROP COLUMN IF EXISTS actor_token_id,
  DROP COLUMN IF EXISTS actor_email,
  DROP COLUMN IF EXISTS actor_user_id,
  DROP COLUMN IF EXISTS actor_kind;

DROP TABLE IF EXISTS api_token_roles;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
