# Managing pipelines with Terraform

The repo ships a native Terraform provider — `fleet-oss/fleet` — so you can
manage pipelines declaratively from a Git repo with drift detection,
previews, import from existing state, etc. No more hand-editing pipelines
via the admin UI or `curl`.

Source lives in [`terraform/provider-fleet/`](../terraform/provider-fleet/).
A minimal, working example is in
[`terraform/examples/basic/`](../terraform/examples/basic/).

## What's supported

| Kind         | Address              | Notes                                                  |
| ------------ | -------------------- | ------------------------------------------------------ |
| Resource     | `fleet_pipeline`     | Full CRUD. Import by UUID or `name=<name>`.            |
| Data source  | `fleet_pipeline`     | Look up one pipeline by `id` or `name`.                |
| Data source  | `fleet_pipelines`    | List every pipeline (metadata only, no content blob).  |
| Data source  | `fleet_collectors`   | Read-only list of collectors seen via `remotecfg`.     |

Legacy REST endpoints (`/legacy/configs`, `/legacy/assignments`, …) are
intentionally **not** exposed — they are preserved on the server for the
Node.js agent path but the primary, pipelines-based model is what you'd
want to codify.

## Build the provider

```bash
cd terraform/provider-fleet
make build                 # -> ./terraform-provider-fleet (arm64/amd64 native)
```

Requires Go ≥ 1.22.

## Wire up dev_overrides

Terraform normally fetches providers from a registry. While iterating
locally we use a CLI dev override so `terraform plan` picks up your
freshly-built binary with no `terraform init` step:

```bash
cp terraform/dev.tfrc.example terraform/dev.tfrc
# edit terraform/dev.tfrc: replace /REPLACE/WITH/ABSOLUTE/PATH/... with the
# absolute path to terraform/provider-fleet on your machine.

export TF_CLI_CONFIG_FILE="$(pwd)/terraform/dev.tfrc"
```

Verify:

```bash
cd terraform/examples/basic
terraform providers
# should print:
#   provider[registry.terraform.io/fleet-oss/fleet] (dev override)
```

## Authenticate

The provider reads configuration from HCL, falling back to environment
variables:

| HCL attribute  | Env var               | Default                    |
| -------------- | --------------------- | -------------------------- |
| `endpoint`     | `FLEET_ENDPOINT`      | `http://localhost:9090`    |
| `admin_token`  | `FLEET_ADMIN_TOKEN`   | *(none — required)*        |

`admin_token` is the same value as `ADMIN_TOKEN` on the manager (see
`.env.example`). Treat it as a secret — don't commit it.

```bash
export FLEET_ENDPOINT=http://localhost:9090
export FLEET_ADMIN_TOKEN=change-me-admin-token
```

## A minimal pipeline

```hcl
terraform {
  required_providers {
    fleet = { source = "fleet-oss/fleet", version = ">= 0.1.0" }
  }
}

provider "fleet" {}   # reads env vars

resource "fleet_pipeline" "edge_metrics" {
  name    = "edge-metrics"
  enabled = true
  selector = {
    role = "edge"
  }
  content = file("${path.module}/pipelines/edge-metrics.alloy")
}
```

`terraform plan` will show a `+ create` on the first apply, then zero-drift
plans on subsequent runs — same semantics you get with any HashiCorp
provider.

## Importing existing pipelines

If you already have pipelines in the DB (e.g. from `scripts/seed.ts` or
hand-crafted via the UI), pull them under Terraform management without
recreating them:

```bash
# By UUID:
terraform import fleet_pipeline.edge_metrics c127d767-391d-4536-9878-0449ec92c615

# Or — more convenient — by name:
terraform import fleet_pipeline.edge_metrics name=edge-metrics
```

Run `terraform plan` right after. If it reports zero changes, the HCL
matches what's in the DB. If it proposes an edit, align the HCL with what
the server has, or apply to overwrite.

## What changes on the server

Every `terraform apply` that touches `content`, `selector`, or `enabled`
calls `PATCH /pipelines/:id`, which the manager turns into a new immutable
row in `pipeline_versions` (see
[docs/data-model.md](./data-model.md)). That means your Git history *and*
the server's internal audit trail agree on every change. Reverting is
usually just a `git revert` + `terraform apply`.

Deletes call `DELETE /pipelines/:id` and remove the row. Version history
rows are kept (tombstones) until garbage-collected.

## Drift detection & out-of-band edits

- If an operator patches `content` via the admin UI, the next `terraform
  plan` will show the diff and propose reverting to the HCL.
- If a pipeline is deleted out-of-band, the resource silently drops from
  state and the next plan proposes re-creating it.
- If the server is unreachable, the plan fails with a clear `fleet-manager
  API error: ... connection refused` diagnostic rather than hanging.

## Read-only data sources

Useful for CI assertions and reporting:

```hcl
data "fleet_collectors" "all" {}

output "bad_collectors" {
  description = "Collector IDs whose last reported status is FAILED."
  value = [
    for c in data.fleet_collectors.all.collectors :
    c.id if c.last_status == "FAILED"
  ]
}

data "fleet_pipelines" "all" {}

# Example: make CI fail if a pipeline named "base-remote-write" is missing.
check "base_remote_write_exists" {
  assert {
    condition = anytrue([
      for p in data.fleet_pipelines.all.pipelines : p.name == "base-remote-write"
    ])
    error_message = "base-remote-write pipeline is missing; the fleet will silently drop metrics."
  }
}
```

## Releasing a real version

For operators who want to consume the provider from a registry instead of a
dev override, build and sign a GoReleaser archive targeting the
Terraform registry protocol. That's out of scope for this MVP — file an
issue if you need it and we'll wire it up.

## Known limitations

- **No rollout / canary resource yet.** The selector model lets you roll
  out by flipping labels on collectors, but there's no `fleet_rollout`
  resource that sequences multiple pipeline changes. Trivial future work.
- **Content is a string.** There's no syntax validation beyond the
  brace/quote sanity check in
  [`apps/fleet-manager/src/services/validator.ts`](../apps/fleet-manager/src/services/validator.ts).
  A bad fragment will be served to collectors and surface as
  `last_status=FAILED` on the next heartbeat — visible on the UI, in the
  `fleet_collectors` data source, and in manager logs.
- **No state-backed `rollback`.** Terraform only tracks `current_version`;
  rolling back to an older `pipeline_versions` row requires the admin API
  or UI directly.
