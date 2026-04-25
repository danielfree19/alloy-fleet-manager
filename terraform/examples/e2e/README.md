# 0-to-100 e2e Terraform example

This example drives the full docker-compose stack — postgres, fleet-manager,
Alloy, prom-sink — declaratively. It exercises every resource and data
source the `fleet-oss/fleet` provider ships and provides outputs the
companion test script asserts on.

For the run-book, see [`docs/e2e-terraform.md`](../../../docs/e2e-terraform.md).
For the automation, run [`scripts/e2e-terraform.sh`](../../../scripts/e2e-terraform.sh).

## What's in the plan

| Resource / data source       | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `fleet_pipeline` ×3          | Fleet-wide sink + self-metrics, plus an edge-only pipeline.        |
| `fleet_user` ×2              | A pure-`agent` service account and a dual `agent+viewer` account.  |
| `fleet_api_token` ×2         | Per-Alloy `agent` token + read-only `viewer` CI token.             |
| `data.fleet_roles`           | Resolves built-in role ids by name.                                |
| `data.fleet_pipelines`       | Asserts via a `check` block that `base-remote-write` exists.       |
| `data.fleet_collectors`      | Surfaces APPLIED-status collector ids as an output.                |

## Quick run (from the repo root)

```bash
# Bring everything up, apply, verify, leave the stack running.
ENABLE_TEARDOWN=0 scripts/e2e-terraform.sh

# Tear down + bring up + apply + verify + teardown.
scripts/e2e-terraform.sh
```

## Running by hand

```bash
# 1. Build the provider once.
( cd terraform/provider-fleet && go build -o terraform-provider-fleet . )

# 2. Point Terraform at the locally-built binary.
cp terraform/dev.tfrc.example terraform/dev.tfrc
# edit dev.tfrc so the path is absolute (see comments inside the file)
export TF_CLI_CONFIG_FILE="$(pwd)/terraform/dev.tfrc"

# 3. Bring the compose stack up (with-alloy profile starts Alloy + prom-sink).
#    Use whichever compose CLI you have — `docker compose`, `podman compose`,
#    `podman-compose`, or legacy `docker-compose` all work the same here.
docker compose --profile with-alloy up -d --build

# 4. Apply.
export FLEET_ENDPOINT=http://localhost:9090
export FLEET_ADMIN_TOKEN=change-me-admin-token
terraform -chdir=terraform/examples/e2e apply -auto-approve

# 5. Read outputs.
terraform -chdir=terraform/examples/e2e output pipeline_names
terraform -chdir=terraform/examples/e2e output -raw agent_token   # secret!
```
