# Template catalog

The **template catalog** is a curated library of pre-built Alloy pipeline
fragments (node_exporter, postgres, nginx scraping, systemd journal to
Loki, OTLP forwarding, etc.). Operators browse it from the UI or CLI and
install a template as a new pipeline in one click — the form is
pre-filled from the template's defaults and the user can edit name,
selector, and content before saving.

The catalog is intentionally **read-only** over the API. Editing the
catalog means editing source (bundled JSON in this repo, or a remote
JSON URL you control). There is no "publish" flow and no user-generated
content — that would turn the catalog into a marketplace with
moderation, ratings, and trust problems we don't want to solve.

---

## Architecture

```
                          ┌─────────────────────────┐
bundled catalog/          │ apps/fleet-manager      │
  templates.json ────────►│  src/catalog/loader.ts  │
                          │  - validates (zod)      │
FLEET_CATALOG_URL  ──────►│  - merges remote on top │
  (optional)              │  - caches in-process    │
                          └─────────────┬───────────┘
                                        │
                                        ▼
                           GET /catalog        (list, no content)
                           GET /catalog/:id    (full, with content)
                                        │
                ┌───────────────────────┼──────────────────────┐
                ▼                       ▼                      ▼
         Fleet UI                    fleetctl              @fleet-oss/sdk
     /ui/catalog page          `fleetctl catalog …`      `client.listCatalog()`
         "Install"             `fleetctl catalog install …`
```

The bundled file (`catalog/templates.json` at the repo root) is always
the base layer. When `FLEET_CATALOG_URL` is set the remote catalog is
**merged on top**: templates with the same `id` override the bundled
entry, and new ids are appended. This lets organizations extend the
defaults without re-declaring everything.

---

## Bundled templates

The repo ships with 10 starter templates covering the most common
cases. See `catalog/templates.json` for full content.

| ID                        | Category | What it does                                            |
| ------------------------- | -------- | ------------------------------------------------------- |
| `remote-write-sink`       | sinks    | Fan-in `prometheus.remote_write` receiver               |
| `alloy-self-metrics`      | metrics  | Scrapes Alloy's own `/metrics` endpoint                 |
| `node-exporter`           | metrics  | Linux host metrics via `prometheus.exporter.unix`       |
| `postgres-exporter`       | metrics  | Postgres via `prometheus.exporter.postgres`             |
| `elasticsearch-exporter`  | metrics  | Elasticsearch via `prometheus.exporter.elasticsearch`   |
| `nginx-exporter-scrape`   | metrics  | Scrapes an external `nginx-prometheus-exporter`         |
| `k8s-pod-metrics`         | metrics  | Kubernetes pod discovery with `prometheus.io/scrape`    |
| `systemd-journal-logs`    | logs     | `loki.source.journal` → Loki                            |
| `docker-container-logs`   | logs     | `loki.source.docker` via the Docker socket              |
| `otlp-traces-forwarder`   | traces   | `otelcol.receiver.otlp` → remote OTLP endpoint          |

## Template schema

```jsonc
{
  "version": 1,
  "templates": [
    {
      "id": "node-exporter",              // lowercase slug, unique
      "name": "Node (Linux host) metrics", // display name
      "description": "…",                 // 1–2 sentence summary
      "category": "metrics",              // metrics | logs | traces | sinks | infra
      "tags": ["host", "linux"],          // free-form, used by UI search
      "default_selector": { "collector.os": "linux" },
      "suggested_name": "node-exporter",  // optional; falls back to id
      "docs_url": "https://…",            // optional external reference
      "requires": [                        // optional, free-form prerequisites
        "`prometheus.remote_write.sink.receiver` must exist"
      ],
      "content": "prometheus.exporter.unix …"  // the Alloy fragment
    }
  ]
}
```

Validation is enforced by `apps/fleet-manager/src/catalog/schema.ts`
(zod). A malformed catalog fails the manager's startup; a malformed
**remote** catalog is logged loudly and the manager keeps running with
the bundled catalog alone.

---

## HTTP API

All catalog endpoints require `Authorization: Bearer $ADMIN_TOKEN`.

### `GET /catalog`

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:9090/catalog
```

```jsonc
{
  "sources": [
    "bundled:/app/catalog/templates.json",
    "remote:https://example.com/org-catalog.json"
  ],
  "templates": [
    {
      "id": "node-exporter",
      "name": "Node (Linux host) metrics",
      "description": "…",
      "category": "metrics",
      "tags": ["host", "linux"],
      "default_selector": { "collector.os": "linux" },
      "suggested_name": "node-exporter",
      "docs_url": "https://…",
      "requires": ["…"]
    }
    // ...
  ]
}
```

`content` is omitted to keep list responses small. Use `GET /catalog/:id`
to retrieve it.

### `GET /catalog/:id`

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:9090/catalog/node-exporter
```

```jsonc
{
  "template": {
    "id": "node-exporter",
    "name": "Node (Linux host) metrics",
    "content": "prometheus.exporter.unix …",
    // + every field from the list response
  }
}
```

Returns `404` with `{ "error": "not_found", "id": "<requested>" }` if
the id is unknown.

---

## Using from the UI

1. Navigate to **Catalog** in the sidebar (or click **Browse catalog**
   from the Pipelines page).
2. Pick a template. Each card shows the category, a description, tags,
   the default selector, and any prerequisites.
3. Click **Install**. You land on `/ui/pipelines/new?from_template=<id>`,
   which pre-fills name, selector, enabled, and content from the template.
4. Edit anything you want. Click **Validate** to run strict Alloy syntax
   checks, then **Create pipeline**.

The install flow intentionally stops at "form pre-filled" rather than
one-click creating the pipeline — most templates want a tweak (a
selector label, a tighter scrape interval, a `remote_write` URL).

---

## Using from `fleetctl`

```bash
# List everything
fleetctl catalog list

# Filter by category
fleetctl catalog list --category=metrics

# View a single template, including the Alloy content
fleetctl catalog get node-exporter

# Install a template (GET /catalog/:id + POST /pipelines in one call)
fleetctl catalog install node-exporter

# With overrides
fleetctl catalog install postgres-exporter \
    --name=postgres-prod \
    --selector role=postgres \
    --selector env=prod

# Start disabled, in case you want to review the assembled config first
fleetctl catalog install k8s-pod-metrics --disabled
```

`--selector` **replaces** the template's `default_selector` (it doesn't
merge). This is deliberate: selector targeting is subtle enough that
"this is the full selector" is the clearest mental model.

---

## Using from `@fleet-oss/sdk`

```ts
import { FleetClient } from "@fleet-oss/sdk";

const client = new FleetClient({
  endpoint: "http://localhost:9090",
  adminToken: process.env.FLEET_ADMIN_TOKEN!,
});

const catalog = await client.listCatalog();
console.log(`${catalog.templates.length} templates available`);

// Install with defaults
const pipeline = await client.installCatalogTemplate("node-exporter");

// Install with overrides
const custom = await client.installCatalogTemplate("postgres-exporter", {
  name: "postgres-staging",
  selector: { role: "postgres", env: "staging" },
  enabled: false,
});
```

`installCatalogTemplate` is a thin wrapper around `getCatalogTemplate`
+ `createPipeline`. Everything is plain HTTP — you can also build your
own install flow by calling the two methods separately if you want
custom preprocessing.

---

## Hosting a remote catalog

To point the manager at your own catalog:

```bash
# In the fleet-manager container's environment:
FLEET_CATALOG_URL=https://raw.githubusercontent.com/acme-org/fleet-catalog/main/templates.json
```

Requirements:

- Must return `application/json` matching the schema above.
- Must be reachable from the manager at startup (10s timeout).
- Must be world-readable, OR served behind a network boundary that
  authenticates transparently (we don't pass the admin token to the
  upstream URL — it'd be a footgun).

If the remote fetch fails at startup, the manager logs an error and
continues with the bundled catalog. This keeps a flaky upstream from
taking down your control plane.

To force a reload (e.g. after pushing a new template to your remote
repo) restart the manager. There's no hot-reload endpoint yet — when
catalogs are mostly static it hasn't been worth the operational
surface area.

---

## Contributing templates

To add a template to the bundled catalog:

1. Edit `catalog/templates.json` at the repo root.
2. Ensure the `id` is a lowercase slug, unique across the file.
3. Test locally: `podman compose up -d fleet-manager`, then
   `curl -H "Authorization: Bearer …" http://localhost:9090/catalog`
   should show your new template.
4. Open a PR. The schema is enforced at startup; syntactically invalid
   catalog files fail CI.

Good template content:

- Uses `sys.env()` for secrets and site-specific values. Never hardcode
  URLs, DSNs, or credentials.
- References `prometheus.remote_write.sink.receiver` / `loki.write.sink.receiver`
  rather than declaring its own sink. The `remote-write-sink` template is
  the fleet-wide sink pattern.
- Includes realistic `default_selector` values when the template is not
  universal (e.g. `{ collector.os: "linux" }` for node_exporter).
- Documents prerequisites in `requires` so operators know what to
  deploy alongside.
