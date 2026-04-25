# Audit log

Every admin-initiated pipeline mutation writes exactly one row to the
`audit_events` table. Writes happen inside the same transaction as the
mutation, so the audit log is always consistent with the state of
`pipelines` + `pipeline_versions`.

## Schema

```sql
CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,       -- "admin-token:<8-hex>" for admin callers
  action       text NOT NULL,       -- pipeline.create | pipeline.update | pipeline.delete
  target_kind  text NOT NULL,       -- "pipeline"
  target_id    text,                -- uuid of the pipeline (null on pre-create failures)
  target_name  text,                -- denormalized for post-delete lookups
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);
```

The table is intentionally **append-only**. There is no UPDATE or DELETE
path exposed to the API. Redaction, if you need it, goes through a
separate sanitization process.

## What's captured

| Action             | `metadata` shape                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `pipeline.create`  | `{ selector, enabled, version: 1, hash, content_bytes }`                                                        |
| `pipeline.update`  | `{ changed_fields: ["selector"\|"enabled"\|"content"], before: {...}, after: {...} }`                           |
| `pipeline.delete`  | `{ selector, last_version }`                                                                                    |

The full pipeline content is **not** duplicated into the audit row — it
lives in `pipeline_versions` already. The metadata keeps diffs small so
the table stays queryable.

## Actor identification

The admin auth middleware hashes the bearer token (SHA-256, first 8 hex
chars) and records it as `admin-token:abc12345`. This lets operators
correlate multiple events to the same credential without ever storing
the raw token.

If you later move to multi-tenant tokens, just feed a friendly name
into the hash helper and the existing audit rows continue to work.

## API

```
GET /audit
  Auth: Bearer <ADMIN_TOKEN>
  Query: target_kind, target_id, action, actor, before (RFC3339), limit (1..500)
  Response: { events: AuditEvent[], limit: number }
```

Most-recent-first. `before` + `created_at` of the last row you saw give
you a simple keyset-pagination cursor.

## UI

Two surfaces:

- **Global page** at `/ui/audit` — full timeline with action + actor filters.
- **Per-pipeline section** at the bottom of every pipeline edit page —
  history filtered to `target_id = <this pipeline>`. Useful for "who
  disabled this last Thursday?"

## CLI

```bash
fleetctl audit --action pipeline.update --limit 20
fleetctl audit --target-id 3a2f... -o json | jq '.[] | .actor'
```

See [fleetctl.md](fleetctl.md) for the full flag surface.
