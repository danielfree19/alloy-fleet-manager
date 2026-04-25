-- Up Migration
-- Initial schema for the Alloy Fleet Manager MVP.
-- All tables mirror the data model in the handoff doc; fields with trailing
-- comments marked "(MVP extension)" are additions that preserve future
-- extension points without changing the documented shape.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- collectors
-- ---------------------------------------------------------------------------
CREATE TABLE collectors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname               text NOT NULL,
  ip                     text,
  environment            text NOT NULL,
  labels                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen              timestamptz,
  status                 text NOT NULL DEFAULT 'unknown',
  current_config_version uuid,                                     -- FK added after config_versions exists
  api_key_hash           text NOT NULL,                            -- sha256 hex of per-agent bearer token (MVP extension)
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hostname, environment)
);

CREATE INDEX collectors_labels_gin ON collectors USING GIN (labels);
CREATE INDEX collectors_environment_idx ON collectors (environment);

-- ---------------------------------------------------------------------------
-- configs  (template, named)
-- ---------------------------------------------------------------------------
CREATE TABLE configs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  template   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- config_versions  (immutable rendered snapshot)
-- ---------------------------------------------------------------------------
CREATE TABLE config_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       uuid NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  rendered_output text NOT NULL,
  checksum        text NOT NULL,                                   -- sha256 of rendered_output (MVP extension)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (config_id, version)
);

CREATE INDEX config_versions_config_id_idx ON config_versions (config_id);

-- Now that config_versions exists we can link the FK on collectors.
ALTER TABLE collectors
  ADD CONSTRAINT collectors_current_config_version_fk
  FOREIGN KEY (current_config_version) REFERENCES config_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- assignments  (one active assignment per collector; history deferred)
-- ---------------------------------------------------------------------------
CREATE TABLE assignments (
  collector_id       uuid PRIMARY KEY REFERENCES collectors(id) ON DELETE CASCADE,
  config_version_id  uuid NOT NULL REFERENCES config_versions(id) ON DELETE RESTRICT,
  assigned_at        timestamptz NOT NULL DEFAULT now()            -- (MVP extension)
);

CREATE INDEX assignments_config_version_idx ON assignments (config_version_id);

-- ---------------------------------------------------------------------------
-- heartbeats
-- ---------------------------------------------------------------------------
CREATE TABLE heartbeats (
  id                bigserial PRIMARY KEY,
  collector_id      uuid NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
  timestamp         timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL,
  message           text,
  reported_version  uuid REFERENCES config_versions(id) ON DELETE SET NULL  -- (MVP extension)
);

CREATE INDEX heartbeats_collector_ts_idx ON heartbeats (collector_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- rollout_events
-- ---------------------------------------------------------------------------
CREATE TABLE rollout_events (
  id                bigserial PRIMARY KEY,
  config_version_id uuid NOT NULL REFERENCES config_versions(id) ON DELETE CASCADE,
  collector_id      uuid NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('pending','success','failed')),
  message           text,                                          -- (MVP extension)
  timestamp         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rollout_events_collector_ts_idx ON rollout_events (collector_id, timestamp DESC);
CREATE INDEX rollout_events_config_version_idx ON rollout_events (config_version_id);

-- Down Migration
DROP TABLE IF EXISTS rollout_events;
DROP TABLE IF EXISTS heartbeats;
DROP TABLE IF EXISTS assignments;
ALTER TABLE IF EXISTS collectors DROP CONSTRAINT IF EXISTS collectors_current_config_version_fk;
DROP TABLE IF EXISTS config_versions;
DROP TABLE IF EXISTS configs;
DROP TABLE IF EXISTS collectors;
