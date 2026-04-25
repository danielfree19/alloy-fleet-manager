-- Up Migration
-- Add the `collectors.poll` permission and seed a fourth built-in role
-- (`agent`) that grants only it.
--
-- Background:
-- The remotecfg endpoints (`/collector.v1.CollectorService/*`) used to
-- be guarded by a single shared bearer (`AGENT_BEARER_TOKEN` env var).
-- That stays as a back-compat fast-path, but Alloy instances can now
-- ALSO authenticate with a regular `fmt_…` API token — provided that
-- token carries a role with `collectors.poll`.
--
-- The point of the `agent` built-in role is to make it trivially safe
-- to mint a per-collector token from the UI: pick `agent`, hand the
-- secret to the Alloy instance, done. The token cannot read pipelines,
-- cannot list users, cannot do anything except call the three
-- CollectorService RPCs.
--
-- This migration is purely additive. Existing roles, users, and tokens
-- keep working untouched, and the legacy AGENT_BEARER_TOKEN keeps
-- working too (the remotecfg auth handler tries it first).

-- ---------------------------------------------------------------------------
-- Extend admin with the new permission
-- ---------------------------------------------------------------------------
-- Strictly speaking the env-token actor (ADMIN_TOKEN bearer) already
-- has every permission via `envTokenActor()` in code, so admins were
-- never blocked at the remotecfg layer. We still add the row so the
-- DB-backed admin role's permission set matches the code-side
-- ALL_PERMISSIONS list — keeps `SELECT permission FROM role_permissions
-- WHERE role_id = (SELECT id FROM roles WHERE name = 'admin')` honest.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'collectors.poll'
FROM roles r
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: agent role
-- ---------------------------------------------------------------------------
-- Built-in, immutable, single-permission. The routes layer prevents
-- editing/deleting builtins, so an operator can rely on this role
-- continuing to mean exactly "may poll remotecfg, nothing else".

INSERT INTO roles (id, name, description, builtin)
VALUES (
  gen_random_uuid(),
  'agent',
  'Pull remotecfg configs. Used by Alloy instances to authenticate to /collector.v1.CollectorService/*.',
  true
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'collectors.poll'
FROM roles r
WHERE r.name = 'agent'
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'agent')
   AND permission = 'collectors.poll';

DELETE FROM roles WHERE name = 'agent' AND builtin = true;

DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE name = 'admin')
   AND permission = 'collectors.poll';
