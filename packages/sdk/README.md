# @fleet-oss/sdk

[![npm](https://img.shields.io/npm/v/@fleet-oss/sdk.svg)](https://www.npmjs.com/package/@fleet-oss/sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE)

TypeScript client for the self-hosted Alloy Fleet Manager admin API.

Works unmodified in Node.js (≥20), browsers, Bun, and Deno — it uses the
global `fetch` and ships no runtime dependencies.

## Install

Inside this monorepo it's a workspace package. For external use:

```bash
npm install @fleet-oss/sdk
```

## Usage

```ts
import { FleetClient } from "@fleet-oss/sdk";

const fleet = new FleetClient({
  endpoint: process.env.FLEET_ENDPOINT!,      // e.g. http://localhost:9090
  adminToken: process.env.FLEET_ADMIN_TOKEN!, // same token as the manager's ADMIN_TOKEN
});

// List pipelines
const pipelines = await fleet.listPipelines();

// Create a pipeline
await fleet.createPipeline({
  name: "edge-metrics",
  selector: { role: "edge" },
  enabled: true,
  content: `
    prometheus.exporter.unix "default" { }
    prometheus.scrape "node" {
      targets    = prometheus.exporter.unix.default.targets
      forward_to = [prometheus.remote_write.sink.receiver]
    }
  `.trim(),
});

// Preview the assembled config for a hypothetical collector
const assembled = await fleet.assembleForAttributes({ env: "prod", role: "edge" });
console.log(assembled.content);

// Audit
const history = await fleet.listAuditEvents({ limit: 20 });

// Catalog
const { templates } = await fleet.listCatalog();
await fleet.installCatalogTemplate("node-exporter", {
  selector: { role: "worker", env: "prod" },
});
```

## Error handling

Every non-2xx response is thrown as a `FleetApiError`:

```ts
import { FleetApiError } from "@fleet-oss/sdk";

try {
  await fleet.createPipeline({ /* ... */ });
} catch (err) {
  if (err instanceof FleetApiError && err.status === 409) {
    console.log("pipeline name taken");
  } else {
    throw err;
  }
}
```

## API surface

| Area      | Methods                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| Pipelines | `listPipelines`, `getPipeline`, `getPipelineByName`, `createPipeline`, `updatePipeline`, `deletePipeline` |
| Preview   | `assembleForAttributes`, `validatePipelineContent`                                |
| Collectors| `listCollectors`                                                                  |
| Catalog   | `listCatalog`, `getCatalogTemplate`, `installCatalogTemplate`                     |
| Audit     | `listAuditEvents`                                                                 |
| Low-level | `request(method, path, body?)` — raw helper for endpoints added post-release      |

## Custom `fetch`

Pass a custom fetch (e.g. for tracing, retries, or tests):

```ts
const fleet = new FleetClient({
  endpoint: "http://localhost:9090",
  adminToken: "secret",
  fetch: tracedFetch,
  defaultHeaders: { "x-request-id": "abc-123" },
});
```
