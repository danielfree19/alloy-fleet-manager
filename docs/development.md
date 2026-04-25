# Development

## Prerequisites

- Node.js 20+
- Docker (for Postgres and optionally Alloy)

## Setup

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run build --workspace packages/shared
npm run migrate
npm run seed
```

Seed creates two primary pipelines (`base-logging`, `edge-metrics`) plus a
legacy collector + config so both paths have something to read.

## Dev loops

| Command                   | What it does                                    |
|---------------------------|-------------------------------------------------|
| `npm run dev:manager`     | Fleet Manager on `:9090` with tsx watch         |
| `npm run dev:agent`       | Legacy Node.js agent with tsx watch             |
| `npm run typecheck`       | `tsc --noEmit` across all workspaces            |
| `npm run build`           | `tsc` build across all workspaces               |
| `npm run migrate`         | `node-pg-migrate ... up`                        |
| `npm run seed`            | Reset/refresh demo data                         |
| `scripts/smoke.sh`        | Hit the running Fleet Manager with curl         |

## Project layout

Monorepo with npm workspaces. `packages/shared` has the TS types + zod
schemas imported by both apps. Order of builds matters: build `shared` first
(the `build` script in the root `package.json` handles this).

```
apps/
  fleet-manager/
    src/
      index.ts            # entry: load config, create pool, buildServer, start
      server.ts           # Fastify factory, registers all plugins
      config.ts           # zod-validated env loader
      db/
        pool.ts           # pg.Pool singleton
        migrations/*.sql  # node-pg-migrate sql files
      auth/               # bearer middlewares + per-collector token hashing
      remotecfg/          # Connect RPC handlers (PRIMARY)
        proto.ts          # protobufjs loader + encode/decode helpers
        connect.ts        # unary protocol (proto + JSON)
        handlers.ts       # GetConfig / Register / Unregister business logic
        routes.ts         # Fastify plugin mounting the three endpoints
      routes/
        pipelines.ts      # admin CRUD for pipelines (PRIMARY)
        health.ts
        collectors.ts     # LEGACY
        configs.ts        # LEGACY
        assignments.ts    # LEGACY
        heartbeats.ts     # LEGACY
        rollouts.ts       # LEGACY
        agent-configs.ts  # LEGACY
      services/
        pipeline-assembler.ts  # selector match + concat + hash (PRIMARY)
        renderer.ts            # LEGACY template rendering
        validator.ts           # shared brace-balance sanity check
      scripts/
        seed.ts
  fleet-agent/             # LEGACY (preserved)
    src/
      ...
packages/shared/
proto/collector/v1/collector.proto
examples/
docs/
scripts/
```

## Adding a migration

Drop a new file in `apps/fleet-manager/src/db/migrations/` named
`<timestamp>_<slug>.sql` with an `-- Up Migration` section first and an
`-- Down Migration` section at the bottom. Run `npm run migrate`.

## Testing the Connect RPCs

Without Alloy, use the smoke script or raw curl (see
[remotecfg.md](remotecfg.md)).

With Alloy:

```bash
docker compose --profile with-alloy up alloy
# watch it poll every 30s at http://localhost:12345/
```

The Alloy container mounts `examples/bootstrap.alloy` read-only. Any change
to pipeline content via `PATCH /pipelines/:id` shows up on Alloy within
`poll_frequency`.
