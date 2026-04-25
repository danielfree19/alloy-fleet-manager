# Alloy Fleet Manager (OSS, self-hosted)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![pipeline status](https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/badges/main/pipeline.svg)](https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/pipelines)
[![npm](https://img.shields.io/npm/v/@fleet-oss/sdk?label=%40fleet-oss%2Fsdk)](https://www.npmjs.com/package/@fleet-oss/sdk)
[![Terraform Registry](https://img.shields.io/badge/Terraform-fleet--oss%2Ffleet-7B42BC.svg?logo=terraform)](https://registry.terraform.io/providers/fleet-oss/fleet)
[![DCO](https://img.shields.io/badge/DCO-required-success)](CONTRIBUTING.md#sign-off-dco)

A self-hosted, vendor-neutral replacement for Grafana Cloud Fleet Management.
Built around Grafana Alloy's **native `remotecfg`** block, so Alloy itself is
the agent — no sidecar process per host.

> **Source of truth: [GitLab](https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager).**
> [GitHub](https://github.com/fleet-oss/alloy-fleet-manager) is a read-only
> mirror — please file issues and MRs on GitLab.

## What you get

- **Pull-based by design.** Hosts never expose inbound control ports; Alloy
  polls the Fleet Manager.
- **Upstream-compatible protocol.** The Fleet Manager implements the
  `collector.v1.CollectorService` Connect RPC defined by
  [`grafana/alloy-remote-config`](https://github.com/grafana/alloy-remote-config)
  (Apache-2.0). Future migration to/from Grafana Cloud Fleet Management is a
  config change, not a rewrite.
- **Pipelines + selectors.** Config is composed per-collector from named
  pipelines whose `selector` (jsonb) matches a subset of the collector's
  `local_attributes`.
- **Immutable versioning.** Every pipeline edit appends a row to
  `pipeline_versions` — full audit trail + rollback by `PATCH` to an older
  content.
- **Legacy REST surface preserved.** The earlier Node.js REST + custom agent
  is kept under `/legacy/*` (see [docs/legacy-agent.md](docs/legacy-agent.md))
  so existing automation keeps working.

## High-level architecture

```mermaid
flowchart LR
  Admin[Operator or CI] -->|"HTTPS + ADMIN_TOKEN"| API
  subgraph FleetManager [Fleet Manager]
    API[REST /pipelines CRUD]
    RPC["Connect RPC
/collector.v1.CollectorService"]
    DB[(Postgres)]
  end
  API --> DB
  RPC --> DB
  subgraph Host [Host / Pod]
    Alloy[Grafana Alloy]
  end
  Alloy -->|"remotecfg: GetConfig
Bearer AGENT_BEARER_TOKEN"| RPC
```

## Install

Pre-built artifacts are published on every `vX.Y.Z` tag (see
[`docs/release.md`](docs/release.md)):

```bash
# Container image — fleet-manager (multi-arch: amd64, arm64)
docker pull registry.gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/fleet-manager:latest

# TypeScript / Node SDK
npm install @fleet-oss/sdk

# Terraform provider (registry-published, GPG-verified)
cat <<'EOF' > main.tf
terraform {
  required_providers {
    fleet = { source = "fleet-oss/fleet", version = "~> 0.1" }
  }
}
EOF

# fleetctl Go CLI (Linux / macOS / Windows / FreeBSD)
curl -sSL https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/releases/permalink/latest/downloads/fleetctl_linux_amd64.tar.gz \
  | tar -xz fleetctl && sudo mv fleetctl /usr/local/bin/
fleetctl --version
```

## Quickstart (local dev)

```bash
cp .env.example .env
# edit tokens in .env

docker compose up -d postgres
npm install
npm run build --workspace packages/shared
npm run migrate
npm run seed

# terminal 1
npm run dev:manager

# terminal 2 (optional — brings up a real Alloy wired to the manager)
docker compose --profile with-alloy up alloy

# terminal 3 (optional — dev UI with hot reload on http://localhost:5173)
npm run dev:ui

# smoke test
scripts/smoke.sh
```

Or, for the all-in-one container path:

```bash
docker compose up -d --build postgres fleet-manager
# UI ships inside the fleet-manager image:
open http://localhost:9090/ui/
```

## Docs

- [docs/architecture.md](docs/architecture.md) — components + data flow
- [docs/remotecfg.md](docs/remotecfg.md) — the primary (Alloy-native) path
- [docs/data-model.md](docs/data-model.md) — Postgres schema + rationale
- [docs/api.md](docs/api.md) — every HTTP/RPC endpoint
- [docs/development.md](docs/development.md) — local setup, migrations
- [docs/deployment.md](docs/deployment.md) — Docker + K8s + systemd
- [docs/legacy-agent.md](docs/legacy-agent.md) — the preserved REST pull model
- [docs/ui.md](docs/ui.md) — the admin UI (React SPA served at `/ui/`)
- [docs/state.md](docs/state.md) — UI state management (useState/useReducer + Zustand stores)
- [docs/terraform.md](docs/terraform.md) — native Terraform provider (`fleet_pipeline` resource + data sources)
- [docs/audit.md](docs/audit.md) — append-only audit log for every admin mutation
- [docs/auth.md](docs/auth.md) — identity, RBAC, sessions, API tokens
- [docs/sso.md](docs/sso.md) — OIDC SSO operator guide (Keycloak / GitLab / Google / Auth0 recipes, YAML+UI overlay)
- [docs/validation.md](docs/validation.md) — strict Alloy-syntax validation via `alloy fmt`
- [docs/catalog.md](docs/catalog.md) — curated template catalog + install flow
- [docs/fleetctl.md](docs/fleetctl.md) — Go CLI for scripting/CI workflows
- [docs/sdk.md](docs/sdk.md) — `@fleet-oss/sdk` TypeScript client for Node/browser
- [docs/e2e-terraform.md](docs/e2e-terraform.md) — 0-to-100 end-to-end test (compose + Terraform + real Alloy + prom-sink)
- [docs/ci-cd.md](docs/ci-cd.md) — GitLab pipeline reference + GitHub mirror setup
- [docs/release.md](docs/release.md) — how to cut a release (tagging, artifacts, verification)
- [CONTRIBUTING.md](CONTRIBUTING.md) — local dev, DCO sign-off, MR rules
- [SECURITY.md](SECURITY.md) — vulnerability disclosure process
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [CLAUDE.md](CLAUDE.md) — handoff & context-recovery notes for AI sessions (read first when resuming)

## Repository layout

```
alloy-fleet-oss/
  apps/
    fleet-manager/       # Fastify API — primary (remotecfg) + legacy (REST) surfaces
    fleet-agent/         # LEGACY Node.js agent (preserved, not the primary path)
    fleet-ui/            # React + Vite admin UI; built output mounted at /ui/
  packages/
    shared/              # Shared TS types + zod schemas
  proto/
    collector/v1/        # Vendored Apache-2.0 protobuf from grafana/alloy-remote-config
  catalog/
    templates.json       # Bundled pipeline template catalog (served by the manager)
  terraform/
    provider-fleet/      # Go module — native Terraform provider
    examples/basic/      # Working main.tf for a demo apply
    dev.tfrc.example     # TF_CLI_CONFIG_FILE template for local iteration
  cmd/
    fleetctl/            # Go CLI companion (cobra)
  packages/
    sdk/                 # @fleet-oss/sdk — TypeScript client for Node/browser
  examples/
    bootstrap.alloy      # Minimal /etc/alloy/config.alloy with remotecfg block
    k8s/                 # Minimal Alloy DaemonSet manifest
  scripts/
    smoke.sh             # Manual smoke test
  docs/
  docker-compose.yml
```

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for the full
text and third-party attribution.

## Contributing

We welcome bug reports, feature requests, and merge requests on
**GitLab**. Every commit must carry a DCO `Signed-off-by:` trailer
(`git commit -s`); see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
full guide and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for community
expectations.

## Non-goals / deferred

- GitOps sync (watch a Git repo and materialize pipelines from it)
- Staged/canary rollouts (the selector model already enables operator-driven
  canarying via attribute labelling, but a rollout controller is future work)
- Per-collector mTLS
- Manager self-observability (Prometheus `/metrics` endpoint on the manager
  itself — still on the roadmap)
