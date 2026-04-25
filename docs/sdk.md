# `@fleet/sdk` — TypeScript client

A thin, typed wrapper around the Fleet Manager admin API. Works
unmodified in Node.js (≥18), browsers, Bun, and Deno — it uses the
global `fetch` and ships no runtime dependencies.

Source: [`packages/sdk/`](../packages/sdk/). Full README:
[`packages/sdk/README.md`](../packages/sdk/README.md).

## When to reach for the SDK

- One-off Node.js scripts (cronjobs, health probes, migrations).
- Glue code between the Fleet Manager and another internal API.
- A custom UI or dashboard that needs typed access without
  reimplementing the HTTP client.
- In-browser admin tooling (React/Vue/Svelte) — the shipped UI
  already uses the same shapes defined here.

For declarative pipeline management, use the
[Terraform provider](terraform.md). For ad-hoc shell work, use
[`fleetctl`](fleetctl.md). The SDK is for programmatic access.

## Quick example

```ts
import { FleetClient, FleetApiError } from "@fleet/sdk";

const fleet = new FleetClient({
  endpoint: process.env.FLEET_ENDPOINT!,
  adminToken: process.env.FLEET_ADMIN_TOKEN!,
});

try {
  const { content, pipeline_names } = await fleet.assembleForAttributes({
    env: "prod",
    role: "edge",
  });
  console.log(`matched: ${pipeline_names.join(", ")}`);
  console.log(content);
} catch (err) {
  if (err instanceof FleetApiError) {
    console.error(`HTTP ${err.status}: ${err.message}`, err.body);
    process.exit(1);
  }
  throw err;
}
```

## API surface

See the package README:
[`packages/sdk/README.md`](../packages/sdk/README.md#api-surface).

Highlights:

- `listPipelines`, `getPipeline`, `getPipelineByName`, `createPipeline`,
  `updatePipeline`, `deletePipeline`
- `assembleForAttributes`, `validatePipelineContent`
- `listCollectors`
- `listCatalog`, `getCatalogTemplate`, `installCatalogTemplate` — template
  catalog browsing + one-call install (see [docs/catalog.md](catalog.md))
- `listAuditEvents`
- `request(method, path, body?)` — low-level escape hatch for
  endpoints added post-release

## Type sharing

The SDK types are the source of truth for everything on the
HTTP surface. When adding an endpoint on the server, also add it
to `packages/sdk/src/types.ts` + `client.ts` — the UI and any
external consumers pick up the types automatically.

The UI package currently keeps a local copy of these types under
`apps/fleet-ui/src/api/types.ts` (predating the SDK). A future
cleanup can replace that with `import type ... from "@fleet/sdk"`;
until then the shapes are kept in sync by hand.
