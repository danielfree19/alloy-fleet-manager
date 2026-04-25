# terraform-provider-fleet

Native Terraform provider for the self-hosted Alloy Fleet Manager. Written
in Go with the HashiCorp Plugin Framework (v1).

See [`docs/terraform.md`](../../docs/terraform.md) for the full user-facing
documentation. This README is the developer / contributor guide.

## Layout

```
terraform/provider-fleet/
  main.go                             # providerserver entry, address = fleet-oss/fleet
  internal/provider/
    provider.go                       # provider schema + Configure
    client.go                         # stdlib HTTP client + DTOs
    convert.go                        # DTO <-> tfsdk model helpers
    pipeline_resource.go              # fleet_pipeline resource (CRUD + import)
    pipeline_data_source.go           # data.fleet_pipeline  (single, by id or name)
    pipelines_data_source.go          # data.fleet_pipelines (list)
    collectors_data_source.go         # data.fleet_collectors (list)
```

## Quick build

```bash
make build                 # -> ./terraform-provider-fleet
```

## Iterate without `terraform init`

Use a CLI dev override:

```bash
cp ../dev.tfrc.example ../dev.tfrc
# edit ../dev.tfrc so dev_overrides points at this directory's absolute path
make build
TF_CLI_CONFIG_FILE=$(pwd)/../dev.tfrc \
  FLEET_ENDPOINT=http://localhost:9090 \
  FLEET_ADMIN_TOKEN=change-me-admin-token \
  terraform -chdir=../examples/basic plan
```

No `terraform init` is needed while dev_overrides is active — the binary is
re-invoked on every plan.

## Supported resources & data sources

| Kind         | Address              | Purpose                                        |
| ------------ | -------------------- | ---------------------------------------------- |
| Resource     | `fleet_pipeline`     | Create/update/delete a pipeline. Import by id or `name=<name>`. |
| Data source  | `fleet_pipeline`     | Look up a single pipeline by `id` or `name`.  |
| Data source  | `fleet_pipelines`    | List every pipeline (metadata only).          |
| Data source  | `fleet_collectors`   | List collectors observed via remotecfg.       |

## Behavior notes

- **Names are immutable.** Changing `name` in HCL forces resource replacement
  (destroy + create), because the manager's `PATCH /pipelines/:id` doesn't
  accept `name`.
- **Every apply that touches content/selector/enabled creates a new
  `pipeline_versions` row** on the server. Terraform state only tracks the
  current version; rollback requires API access or the UI.
- **Drift detection is full.** `terraform plan` surfaces out-of-band edits
  (e.g. someone patched `content` via the admin UI) and proposes reverting
  them. If you want to preserve such an edit, run `terraform apply` after
  updating the HCL to match.
- **404 on read** (pipeline deleted out-of-band) silently drops the resource
  from state, so the next plan proposes a recreate rather than erroring.
