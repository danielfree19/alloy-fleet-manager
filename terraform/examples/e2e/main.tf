# ---------------------------------------------------------------------------
# 0-to-100 end-to-end example for the fleet-oss/fleet provider.
#
# Drives the full docker-compose stack:
#   postgres + fleet-manager + alloy + prom-sink
#
# Exercises every resource and data source the provider ships:
#   - fleet_pipeline               (3x: fleet-wide sink, self-metrics, edge-only)
#   - fleet_user                   (service account that owns the agent token)
#   - fleet_api_token              (per-Alloy `agent` token + a viewer CI token)
#   - data.fleet_roles             (lookup by_name)
#   - data.fleet_pipelines         (assertion via `check`)
#   - data.fleet_collectors        (visibility output)
#
# Pair with scripts/e2e-terraform.sh which automates the full lifecycle.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    fleet = {
      source  = "fleet-oss/fleet"
      version = ">= 0.1.0"
    }
  }
}

provider "fleet" {
  # Reads endpoint + admin token from FLEET_ENDPOINT / FLEET_ADMIN_TOKEN.
  # The e2e script exports both to point at the docker-compose manager.
}

# ---------------------------------------------------------------------------
# Pipelines — three fragments composed by the manager into each collector's
# final config based on local_attributes.

resource "fleet_pipeline" "base_remote_write" {
  name     = "base-remote-write"
  enabled  = true
  selector = {} # fleet-wide
  content  = file("${path.module}/pipelines/base-remote-write.alloy")
}

resource "fleet_pipeline" "base_self_metrics" {
  name     = "base-self-metrics"
  enabled  = true
  selector = {} # fleet-wide
  content  = file("${path.module}/pipelines/base-self-metrics.alloy")
}

resource "fleet_pipeline" "edge_metrics" {
  name    = "edge-metrics"
  enabled = true
  selector = {
    role = "edge"
  }
  content = file("${path.module}/pipelines/edge-metrics.alloy")
}

# ---------------------------------------------------------------------------
# Identity / RBAC — service account + per-host agent token.
#
# Pattern: one Terraform-managed user per Alloy fleet (or per host, if you
# want hard isolation). The user's role is `agent`, so the only thing they
# can do is poll remotecfg. The api_token inherits that single role.

data "fleet_roles" "all" {}

# Fleet-wide service account. In a per-host setup, replace with one user
# per Alloy instance and a dedicated for_each loop.
resource "fleet_user" "fleet_agent" {
  email = "fleet-agent@fleet.local"
  name  = "fleet-agent"
  # Never used for login — the user only auths via api tokens — but the
  # manager requires min 8 chars. Rotate via terraform when convenient.
  password = "rotate-me-then-forget"
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

resource "fleet_api_token" "fleet_agent" {
  name     = "compose-alloy"
  user_id  = fleet_user.fleet_agent.id
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

# ---------------------------------------------------------------------------
# A second token wearing the read-only `viewer` role. Demonstrates that
# unrelated tokens (CI dashboards, cron probes) compose with the same
# resource — and that privilege containment is enforced when the owner
# only carries the `agent` role.
#
# We give the viewer-token user BOTH roles (agent + viewer) so the token
# bound to viewer can be issued to them. Without `agent`, Alloy can't
# poll; without `viewer`, the dashboard token would be rejected.

resource "fleet_user" "fleet_observability" {
  email    = "fleet-observability@fleet.local"
  name     = "fleet-observability"
  password = "rotate-me-then-forget"
  role_ids = [
    data.fleet_roles.all.by_name["agent"],
    data.fleet_roles.all.by_name["viewer"],
  ]
}

resource "fleet_api_token" "ci_readonly" {
  name     = "ci-readonly"
  user_id  = fleet_user.fleet_observability.id
  role_ids = [data.fleet_roles.all.by_name["viewer"]]
}

# ---------------------------------------------------------------------------
# Read-only data — surfaced as outputs and used as a CI assertion.

data "fleet_pipelines" "all" {
  # Make sure plan ordering refreshes this AFTER the create above; otherwise
  # a fresh-state apply will read an empty list and the check below will
  # spuriously fail. The depends_on triggers a re-read in the apply phase.
  depends_on = [
    fleet_pipeline.base_remote_write,
    fleet_pipeline.base_self_metrics,
    fleet_pipeline.edge_metrics,
  ]
}

data "fleet_collectors" "all" {
  depends_on = [fleet_pipeline.base_remote_write] # ensure manager is reachable
}

# Hard CI gate: refuse to apply if the fleet-wide remote_write fragment is
# missing. Without it, every other pipeline silently drops its samples.
check "base_remote_write_exists" {
  assert {
    condition = anytrue([
      for p in data.fleet_pipelines.all.pipelines : p.name == "base-remote-write"
    ])
    error_message = "base-remote-write pipeline is missing — every other pipeline would drop samples."
  }
}

# ---------------------------------------------------------------------------
# Outputs.

output "pipeline_names" {
  description = "Names of every pipeline currently on the manager."
  value       = sort([for p in data.fleet_pipelines.all.pipelines : p.name])
}

output "applied_collectors" {
  description = "Collector IDs whose last reported status is APPLIED."
  value = [
    for c in data.fleet_collectors.all.collectors :
    c.id if c.last_status == "APPLIED"
  ]
}

output "agent_token" {
  description = "fmt_… bearer for /etc/alloy/bootstrap.alloy. Treat as secret."
  value       = fleet_api_token.fleet_agent.token
  sensitive   = true
}

output "agent_token_prefix" {
  description = "Non-sensitive prefix of the agent token, for matching against audit logs."
  value       = fleet_api_token.fleet_agent.token_prefix
}

output "ci_readonly_token" {
  description = "fmt_… bearer for read-only CI dashboards / cron probes."
  value       = fleet_api_token.ci_readonly.token
  sensitive   = true
}
