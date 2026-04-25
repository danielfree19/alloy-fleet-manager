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
    user_resource.go                  # fleet_user resource (local-DB user)
    api_token_resource.go             # fleet_api_token resource (per-host bearer)
    roles_data_source.go              # data.fleet_roles (id ↔ name catalogue)
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
| Resource     | `fleet_user`         | Create/update/delete a local-DB user. Import by id or `email=<addr>`. |
| Resource     | `fleet_api_token`    | Mint a long-lived `fmt_…` bearer bound to roles. Plaintext only on create. |
| Data source  | `fleet_pipeline`     | Look up a single pipeline by `id` or `name`.  |
| Data source  | `fleet_pipelines`    | List every pipeline (metadata only).          |
| Data source  | `fleet_collectors`   | List collectors observed via remotecfg.       |
| Data source  | `fleet_roles`        | List RBAC roles + `by_name` map for built-ins (`admin`/`editor`/`viewer`/`agent`). |

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

## Identity resources — design notes

- **`fleet_user.password` is sensitive and write-only.** The manager never
  echoes hashes back, so the Read path preserves whatever was last applied.
  Changing the attribute calls `POST /users/:id/password` (rotate). For
  pure-API service accounts (e.g. owners of `agent`-role tokens) the
  password is unused at runtime; rotate it via `terraform plan` whenever
  you rotate the rest of your secrets.
- **`fleet_api_token` always rotates on edit.** Every user-facing attribute
  carries `RequiresReplace`. This is intentional: the manager has no
  "modify token" path — role swaps must reissue from scratch — and forcing
  destroy+create gives you an audit-log entry per rotation.
- **Plaintext lives in Terraform state.** `fleet_api_token.token` is marked
  `sensitive: true`, but anyone with read access to state can still recover
  it. Use a remote backend with KMS-encrypted state (S3+SSE-KMS, Terraform
  Cloud, HCP, Vault-backed remote state) before scaling per-host token
  issuance. If state encryption isn't an option, stay on the legacy shared
  `AGENT_BEARER_TOKEN` env var on the manager.
- **The `agent` role is the per-Alloy use case.** It carries exactly one
  permission, `collectors.poll`, scoped to the `remotecfg` RPCs. Bind a
  `fleet_api_token` to it and drop `token` into `bootstrap.alloy`'s
  `remotecfg { bearer_token = … }`. See
  [`docs/auth.md`](../../docs/auth.md#per-alloy-agent-tokens) for the
  end-to-end flow.
