# `fleetctl` — Fleet Manager CLI

A Go CLI companion for scripting, CI, and one-off inspection of a running
Fleet Manager. The Terraform provider is the right tool for persistent
declarative state; `fleetctl` is for everything else.

Source: [`cmd/fleetctl/`](../cmd/fleetctl). Single static binary, no
runtime dependencies.

## Install

```bash
cd cmd/fleetctl
go build -o fleetctl .
# Drop the binary into your PATH:
sudo mv fleetctl /usr/local/bin/
```

Or `go install`:

```bash
cd cmd/fleetctl && go install .
# => $(go env GOPATH)/bin/fleetctl
```

## Configure

`fleetctl` reads configuration in this order:

1. Explicit `--endpoint` / `--token` flags.
2. `FLEET_ENDPOINT` / `FLEET_ADMIN_TOKEN` environment variables.
3. Default endpoint `http://localhost:9090` (token has no default —
   commands error out).

```bash
export FLEET_ENDPOINT=https://fleet.internal
export FLEET_ADMIN_TOKEN=$(pass fleet/admin-token)
```

## Commands

### `pipelines list`

```bash
fleetctl pipelines list
fleetctl pipelines list -o json | jq '.[] | select(.enabled) | .name'
```

### `pipelines get <id|name>`

```bash
fleetctl pipelines get edge-metrics --by-name
fleetctl pipelines get 3a2f... -o json
```

Prints metadata, the current content, and version history.

### `pipelines delete <id|name>`

Requires `--yes` (the API call is irreversible):

```bash
fleetctl pipelines delete stale-thing --by-name --yes
```

Writes a `pipeline.delete` audit event under the hood.

### `catalog list` / `catalog get` / `catalog install`

Browse and install pre-built pipeline templates from the catalog (see
[docs/catalog.md](catalog.md)).

```bash
# List templates, optionally filtered by category
fleetctl catalog list
fleetctl catalog list --category=metrics

# View one template, including its Alloy content
fleetctl catalog get node-exporter

# Install a template as a new pipeline (GET /catalog/:id + POST /pipelines)
fleetctl catalog install node-exporter

# Override the template's defaults
fleetctl catalog install postgres-exporter \
    --name=postgres-prod \
    --selector role=postgres \
    --selector env=prod

# Install in disabled state for review
fleetctl catalog install k8s-pod-metrics --disabled
```

`--selector` replaces the template's `default_selector` entirely
(it does not merge).

### `collectors list`

```bash
fleetctl collectors list
```

Shows every Alloy instance the manager has observed via remotecfg,
with last seen / hash / attributes.

### `assemble --attr k=v ...`

Preview the config the manager **would** serve to a hypothetical
collector with these attributes. No side effects.

```bash
fleetctl assemble --attr env=prod --attr role=edge
```

Useful for debugging selector logic without having to register a fake
collector.

### `validate -f path | < stdin`

Ship an Alloy fragment to the strict validator and exit non-zero on
failure. Ideal for CI:

```bash
for f in pipelines/*.alloy; do
  fleetctl validate -f "$f" || exit 1
done
```

Or pipe:

```bash
cat my.alloy | fleetctl validate
```

Result carries the `engine` field (`alloy-fmt` or `builtin`) so you
know whether the strict parser ran.

### `audit`

Query the audit log:

```bash
# last 20 updates across the whole fleet
fleetctl audit --action pipeline.update --limit 20

# every mutation to one pipeline
fleetctl audit --target-id 3a2f-... -o json

# who has been touching things in the last hour?
fleetctl audit --before $(date -u -v-1H +%FT%TZ) | head
```

## Output formats

- `-o table` (default) — aligned plain text for humans
- `-o json` — indented JSON for pipelines, CI, and `jq`

Every command supports both.

## Exit codes

| Code | Meaning                               |
| ---- | ------------------------------------- |
| 0    | success                               |
| 1    | error (network, HTTP error, validate) |
