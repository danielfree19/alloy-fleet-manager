# API reference

All endpoints are on a single HTTP port (`FLEET_MANAGER_PORT`, default 9090).

Auth token headers (set one of these per request depending on the surface):

| Token                   | Used on                                    |
|-------------------------|--------------------------------------------|
| `ADMIN_TOKEN`           | primary admin REST + legacy admin REST     |
| `AGENT_BEARER_TOKEN`    | primary `/collector.v1.CollectorService/*` |
| `REGISTRATION_TOKEN`    | legacy `POST /legacy/collectors/register`  |
| per-collector `api_key` | other legacy `/legacy/*` agent endpoints   |

All tokens are compared with a constant-time equal.

---

## Primary surface

### `GET /health`

Unauthenticated liveness. Returns `{ "status": "ok" }`.

### `POST /pipelines`

Admin. Create a new pipeline + version 1.

```json
{
  "name": "edge-metrics",
  "selector": { "role": "edge" },
  "content": "prometheus.exporter.unix \"default\" { }\n...",
  "enabled": true
}
```

Returns the created pipeline row (201). Name must be unique (`409
pipeline_name_taken` otherwise).

### `GET /pipelines`

Admin. List all pipelines.

### `GET /pipelines/:id`

Admin. Returns `{ pipeline, versions[] }`. Versions are sorted descending.

### `PATCH /pipelines/:id`

Admin. Partial update with any combination of `selector` / `content` /
`enabled`. If `content` or `selector` changed, a new `pipeline_versions` row
is appended and `current_version` bumps. `enabled` can be toggled without
bumping the version.

### `DELETE /pipelines/:id`

Admin. Cascades to `pipeline_versions`. Returns 204.

### `GET /remotecfg/collectors`

Admin. Inventory of Alloy instances that have ever called `GetConfig` or
`RegisterCollector`, including `last_seen`, `last_status`, `last_error`,
`last_hash_served`.

### Connect RPCs at `/collector.v1.CollectorService/*`

See [remotecfg.md](remotecfg.md).

---

## Legacy surface (under `/legacy`)

Every route below mirrors the pre-pivot design. Kept for backward
compatibility.

### Collectors

- `POST /legacy/collectors/register` — registration-token auth. Idempotent on
  `(hostname, environment)`. Returns `{ collector_id, api_key }`.
- `GET /legacy/collectors` — admin. Supports `?environment=&status=`.
- `GET /legacy/collectors/:id` — admin.

### Configs (templates + versions)

- `POST /legacy/configs` — admin. Create named template + version 1.
- `GET /legacy/configs` — admin list.
- `GET /legacy/configs/:id` — admin, includes versions.
- `POST /legacy/configs/:id/versions` — admin, append a new version (body:
  `{ template?, rendered_output? }`).
- `POST /legacy/configs/validate` — admin, sanity-checks a template string.

### Assignments

- `POST /legacy/assignments` — admin. Assign a `config_version_id` to a
  single `collector_id` or to collectors matching a `label_selector`.
- `GET /legacy/assignments` — admin.

### Agent-facing telemetry + config fetch

- `GET /legacy/agent/configs/:collector_id` — agent bearer. Returns the
  current rendered config for the collector.
- `POST /legacy/heartbeats/:collector_id` — agent bearer.
- `POST /legacy/rollout_events/:collector_id` — agent bearer.

---

## Errors

Primary admin REST returns `{ error: string, details?: object }` with
4xx/5xx.

Connect RPCs follow the Connect spec: non-200 with `{ code, message }`
where `code` is `invalid_argument | not_found | unauthenticated |
permission_denied | internal | unimplemented`.
