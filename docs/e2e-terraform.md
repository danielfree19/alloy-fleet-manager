# 0-to-100 e2e test with Terraform + docker-compose

A single command brings up the entire stack, declaratively configures it
with Terraform, drives Alloy through a real `remotecfg` poll, and asserts
that metrics actually arrive at the sink. About 3-4 minutes start to
finish on a warm machine.

```
[scripts/e2e-terraform.sh]
   │
   ├── 1. host preflight  (terraform, go, jq, curl, docker compose)
   ├── 2. compose down -v (clean slate)
   ├── 3. go build the provider + write dev.tfrc
   ├── 4. compose up -d --build (postgres, fleet-manager, alloy, prom-sink)
   ├── 5. wait for /health
   ├── 6. terraform apply (terraform/examples/e2e)
   └── 7. verify:
          a. all 3 pipelines present
          b. agent fmt_… token authenticates against remotecfg
          c. legacy AGENT_BEARER_TOKEN still authenticates
          d. agent token is forbidden from /pipelines (RBAC scoping)
          e. Alloy registered with the manager
          f. prom-sink is receiving samples
          g. re-apply reports zero drift
```

## Prerequisites

| Tool             | Version              | Notes                                                                        |
| ---------------- | -------------------- | ---------------------------------------------------------------------------- |
| A compose CLI    | any recent           | Auto-detected. Tries `docker compose`, `podman compose`, `podman-compose`, `docker-compose` in that order. Force one via `COMPOSE_BIN=...`. |
| Terraform        | ≥ 1.5                | uses `dev_overrides`, no init step                                           |
| Go               | ≥ 1.22               | builds the provider locally                                                  |
| jq, curl         | any                  | used by the verification step                                                |

You don't need a `.env` file in advance — the defaults in `.env.example`
match the script's defaults. If you've customized your `.env`, the script
honours `ADMIN_TOKEN` / `AGENT_BEARER_TOKEN` from it.

## Run it

```bash
# From the repo root.
scripts/e2e-terraform.sh
```

That's the whole thing. On success the last line is:

```
all e2e checks passed
```

Each phase prints `== N. <name> ==` followed by `✓` lines for each
assertion. On failure, the script dumps the relevant container logs so
you can see exactly what broke.

## Common knobs

```bash
# Keep the stack running after the test (browse the UI, run more curls).
ENABLE_TEARDOWN=0 scripts/e2e-terraform.sh

# Don't reset compose state at the start (resume from a prior run).
ENABLE_INITIAL_TEARDOWN=0 scripts/e2e-terraform.sh

# Force a specific compose CLI (otherwise auto-detected).
COMPOSE_BIN="podman compose"  scripts/e2e-terraform.sh
COMPOSE_BIN="docker-compose"  scripts/e2e-terraform.sh   # legacy v1
COMPOSE_BIN="podman-compose"  scripts/e2e-terraform.sh   # python wrapper

# Hit a manager bound to a non-default port.
FLEET_ENDPOINT=http://localhost:19090 scripts/e2e-terraform.sh
```

## What it actually verifies

The script is **not** just a `terraform apply` smoke check. Each phase
exists to catch a specific class of regression:

### 7a — All 3 pipelines exist

```bash
terraform output -json pipeline_names
```

Catches: provider can't reach the manager / `POST /pipelines` regressed
/ the catalog migration broke pipeline storage.

### 7b — Agent api token works against remotecfg

```bash
curl -X POST $FLEET_ENDPOINT/collector.v1.CollectorService/GetConfig \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"e2e-probe","local_attributes":{"env":"dev","role":"edge"},"hash":""}'
```

Catches: the new `collectors.poll` permission isn't recognized / the
`agent` role isn't seeded / `makeRemotecfgAuth` regressed the
identity-token path.

### 7c — Legacy `AGENT_BEARER_TOKEN` still works

Same RPC, different bearer.

Catches: the new identity-token path accidentally killed the legacy
shared-secret path. This is the back-compat guarantee — no Alloy in the
field needs to be reconfigured to upgrade the manager.

### 7d — Agent token is forbidden from `/pipelines`

```bash
curl -i -H "Authorization: Bearer $AGENT_TOKEN" $FLEET_ENDPOINT/pipelines
# expected: HTTP/1.1 403 Forbidden
```

Catches: privilege containment regressed and an `agent`-role token can
do more than poll remotecfg.

### 7e — Alloy registered

The compose stack starts a real Grafana Alloy instance pointed at the
manager via the legacy bearer. Within ~30s of boot it polls
`RegisterCollector` followed by `GetConfig`, which materializes a row in
the `remotecfg_collectors` table. `data.fleet_collectors` surfaces it.

Catches: the Connect-Go RPC server / `local_attributes` parsing /
`assemble.ts` regressed in a way that prevents collector registration.

### 7f — prom-sink received samples

The fleet-wide `base-self-metrics` pipeline scrapes Alloy's own admin
endpoint and forwards via `prometheus.remote_write` to `prom-sink`
(a real Prometheus instance running with `--web.enable-remote-write-receiver`).
Within ~45s the script can query `up` against prom-sink and see series.

Catches: the assembled config produced by `services/assemble.ts` is
malformed or missing a fragment, the manager served the wrong content,
or Alloy rejected it on apply (`last_status=FAILED`).

### 7g — Re-apply is zero-drift

Runs `terraform plan -detailed-exitcode` after the apply. Exit code `2`
means there's a diff, which would imply the provider read path doesn't
faithfully round-trip whatever the manager stores.

Catches: the most common provider bug — Create returns shape A, Read
returns shape B, every plan proposes a no-op edit.

## Failure-mode reference

| Symptom                                                    | Cause                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| step 5 timeouts after 120s                                 | `fleet-manager` is crashlooping. Run `docker compose logs fleet-manager`.              |
| step 7b returns 401                                        | The `agent` role isn't on the manager (migration didn't run) — see `docs/auth.md`.     |
| step 7c returns 401                                        | `AGENT_BEARER_TOKEN` env var mismatch between compose and the script.                  |
| step 7e times out                                          | Alloy can't reach the manager. Check `docker compose logs alloy` for `connect: …`.     |
| step 7f times out, but 7e passed                           | `last_status` on the collector is probably `FAILED` — the pipeline content is invalid. |
| step 7g reports a diff                                     | Provider regression: investigate the diff'd attribute(s).                              |
| `dev_overrides` warnings flooding the output               | Cosmetic. Suppressed in CI by piping `2>/dev/null`.                                    |
| `Error: error in providerserver.Serve`                     | The provider binary is stale or didn't compile. Re-run from a clean checkout.          |

## Inspecting a left-running stack

After `ENABLE_TEARDOWN=0 scripts/e2e-terraform.sh` succeeds:

```bash
# UI (production build, served by the manager):
open http://localhost:9090/ui/
# Sign in with admin@example.com / changeme-on-first-login (BOOTSTRAP_ADMIN_*).

# Audit log via API:
curl -s -H "Authorization: Bearer change-me-admin-token" \
  http://localhost:9090/audit?limit=20 | jq

# Listing the collectors the manager has seen:
curl -s -H "Authorization: Bearer change-me-admin-token" \
  http://localhost:9090/remotecfg/collectors | jq

# Querying the prom-sink:
curl -s 'http://localhost:9091/api/v1/query?query=up' | jq
```

To rotate the agent token without re-running the whole script:

```bash
terraform -chdir=terraform/examples/e2e taint fleet_api_token.fleet_agent
terraform -chdir=terraform/examples/e2e apply -auto-approve
terraform -chdir=terraform/examples/e2e output -raw agent_token
```

## CI usage

The script is designed to be CI-safe — non-zero exit on any failure,
default teardown, deterministic via `set -euo pipefail`. A minimal
GitHub Actions step:

```yaml
- name: e2e (terraform + compose)
  run: scripts/e2e-terraform.sh
  # Compose CLI is auto-detected; only set COMPOSE_BIN if the runner
  # has multiple installed and you want to force one.
```

The default 120-second + 90-second + 120-second waits give plenty of
margin on cold-start runners. Hot-cache local runs typically finish all
3 checks within their first 15s of polling.
