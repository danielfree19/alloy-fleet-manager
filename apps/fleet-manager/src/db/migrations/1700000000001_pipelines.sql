-- Up Migration
-- Pipelines model for native Alloy `remotecfg` integration.
--
-- A "pipeline" is a named chunk of Alloy config with a `selector` (jsonb of
-- required attributes). When a collector calls CollectorService/GetConfig,
-- the server concatenates the current version of every pipeline whose
-- selector is matched by the collector's local_attributes.
--
-- This table lives ALONGSIDE the legacy configs/config_versions/assignments
-- tables (1700000000000_init.sql) — the legacy REST agent continues to work.

-- The pipeline row holds pointers to the "current" version so GetConfig is a
-- cheap read. Every update bumps current_version by inserting a new
-- pipeline_versions row.
CREATE TABLE pipelines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  selector         jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  current_version  integer NOT NULL DEFAULT 1,
  current_content  text NOT NULL,
  current_hash     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipelines_selector_gin ON pipelines USING GIN (selector);
CREATE INDEX pipelines_enabled_idx ON pipelines (enabled);

-- Immutable history — one row per (pipeline_id, version) snapshot.
CREATE TABLE pipeline_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  content     text NOT NULL,
  hash        text NOT NULL,
  selector    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version)
);

CREATE INDEX pipeline_versions_pipeline_idx ON pipeline_versions (pipeline_id);

-- remotecfg_collectors: state reported by Alloy instances via
-- RegisterCollector / GetConfig. Kept separate from the legacy `collectors`
-- table because the identity model is different:
--   - legacy `collectors.id` is a UUID minted by the server on register
--   - remotecfg `id` is whatever the Alloy operator set (default
--     `constants.hostname`), which is a free-form string
CREATE TABLE remotecfg_collectors (
  id                 text PRIMARY KEY,
  name               text,
  local_attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen          timestamptz NOT NULL DEFAULT now(),
  last_status        text,                                 -- APPLIED | APPLYING | FAILED | UNSET
  last_error         text,
  last_hash_served   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX remotecfg_collectors_attrs_gin ON remotecfg_collectors USING GIN (local_attributes);

-- Down Migration
DROP TABLE IF EXISTS remotecfg_collectors;
DROP TABLE IF EXISTS pipeline_versions;
DROP TABLE IF EXISTS pipelines;
