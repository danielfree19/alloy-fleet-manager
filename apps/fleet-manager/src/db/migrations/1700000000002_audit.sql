-- Up Migration
-- Append-only audit trail for every admin-initiated mutation.
--
-- Every pipeline create/update/delete writes exactly one row here inside the
-- same transaction as the mutation, so the audit log is always consistent
-- with the state of the `pipelines` + `pipeline_versions` tables. The
-- writes are done via a small helper in `services/audit.ts` — never from
-- triggers — because we want application-level context (actor, diffs).
--
-- This table is intentionally append-only. There is no UPDATE or DELETE
-- path exposed to the API. Operators who need to redact an event should do
-- it via a separate sanitization process.

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,             -- short identifier, e.g. "admin" or "admin-token:abc12345"
  action       text NOT NULL,             -- "pipeline.create" | "pipeline.update" | "pipeline.delete"
  target_kind  text NOT NULL,             -- "pipeline"
  target_id    text,                      -- uuid string for pipelines (nullable for pre-create failures)
  target_name  text,                      -- denormalized for search + pretty logs after a delete
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Global timeline view; most recent first.
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

-- Per-object history lookup: "show me every change to this pipeline."
CREATE INDEX audit_events_target_idx
  ON audit_events (target_kind, target_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_events;
