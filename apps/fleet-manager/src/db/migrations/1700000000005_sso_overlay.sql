-- Up Migration
-- SSO (Phase 2): identity provider DB overlay + per-provider group→role
-- mappings + the two new permissions that gate the admin surface.
--
-- Architecture (see docs/sso.md):
--
--   sso.yaml       (bootstrap, GitOps, source = "yaml")
--      │
--      └──merge──┐
--                ▼
--   identity_providers   (DB overlay, source = "ui")
--                │
--                └─< identity_provider_role_mappings (group → role)
--
-- A given provider id can live in YAML, in DB, or both. When both
-- carry the same id the DB row WINS — that's how the UI editor
-- materializes a tweak without removing the YAML source-of-truth.
-- The plan documents the trade-off; the registry does the actual
-- merge.
--
-- All columns are intentionally additive — nothing pre-existing is
-- altered, so this migration is safe to run on a Phase 1 deployment
-- that has live users and api_tokens.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- identity_providers
-- ---------------------------------------------------------------------------
-- One row per provider that's been EITHER seeded from YAML at boot OR
-- created/edited in the UI. `source` records which produced this row;
-- the UI shows a badge accordingly.
--
--   source = 'yaml'  — synthesized at boot from a YAML provider that
--                      had no DB row yet. Editing this row in the UI
--                      flips its source to 'ui' (the YAML defaults
--                      from then on are ignored for this id).
--   source = 'ui'    — created or last-edited via the admin API.
--
-- `client_secret` is NEVER returned to the UI in cleartext (the route
-- masks it with '***'); we still store it as plain text because the
-- only realistic protection in our threat model is OS-level FS perms
-- on the Postgres data dir. Operators concerned about this should use
-- pgcrypto / external secret stores.
CREATE TABLE identity_providers (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('oidc', 'saml')),
  display_name  text NOT NULL DEFAULT '',
  issuer        text,
  client_id     text,
  client_secret text,
  redirect_uri  text,
  scopes        text[] NOT NULL DEFAULT ARRAY['openid', 'email', 'profile']::text[],
  groups_claim  text NOT NULL DEFAULT 'groups',
  source        text NOT NULL CHECK (source IN ('yaml', 'ui')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- identity_provider_role_mappings
-- ---------------------------------------------------------------------------
-- (provider_id, group_value) → role_id. A user gets the union of every
-- role whose group_value is present in their IdP `groups` claim.
--
-- We INTENTIONALLY don't enforce that role_id refers to a builtin role
-- — operators may want to map "/fleet-secops" to a custom role they
-- mint in the UI. Deletion of the role cascades to remove the mapping.
CREATE TABLE identity_provider_role_mappings (
  provider_id  text NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  group_value  text NOT NULL,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (provider_id, group_value, role_id)
);

CREATE INDEX identity_provider_role_mappings_provider_idx
  ON identity_provider_role_mappings (provider_id);

-- ---------------------------------------------------------------------------
-- Seed: extend admin role with sso.read + sso.write
-- ---------------------------------------------------------------------------
-- Like 1700000000004_agent_role.sql, the env-token actor already has
-- every permission via `envTokenActor()` in code. We still insert the
-- rows so the DB-side admin role is consistent with code-side
-- ALL_PERMISSIONS — that's what the UI's "Roles" page displays.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p
FROM roles r,
     unnest(ARRAY['sso.read', 'sso.write']) AS p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
   AND permission IN ('sso.read', 'sso.write');

DROP TABLE IF EXISTS identity_provider_role_mappings;
DROP TABLE IF EXISTS identity_providers;
