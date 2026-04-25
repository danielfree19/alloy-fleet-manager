terraform {
  required_version = ">= 1.5.0"
  required_providers {
    fleet = {
      # This address matches the Address: field in cmd/main.go. When iterating
      # locally you'll point Terraform at your freshly-built binary via
      # `dev_overrides` in ~/.terraformrc (see docs/terraform.md). In that
      # mode `terraform init` is NOT required.
      source  = "fleet-oss/fleet"
      version = ">= 0.1.0"
    }
  }
}

provider "fleet" {
  # Omit either attribute to read from FLEET_ENDPOINT / FLEET_ADMIN_TOKEN
  # instead. Hard-coding a token here is fine for a quick local demo but
  # should never land in source control.
  endpoint    = "http://localhost:9090"
  admin_token = "change-me-admin-token"
}

# ---------------------------------------------------------------------------
# Pipelines — declarative Alloy fragments. Each `fleet_pipeline` becomes a
# row in the `pipelines` table. Editing `content`, `selector`, or `enabled`
# produces a new immutable row in `pipeline_versions` on apply.

resource "fleet_pipeline" "base_remote_write" {
  name     = "base-remote-write"
  enabled  = true
  selector = {} # fleet-wide
  content  = <<-EOT
    // base-remote-write: fan-in receiver for every prometheus.scrape.
    prometheus.remote_write "sink" {
      endpoint {
        url = "http://prom-sink:9091/api/v1/write"
      }
    }
  EOT
}

resource "fleet_pipeline" "base_self_metrics" {
  name    = "base-self-metrics"
  enabled = true
  selector = {}
  content = <<-EOT
    prometheus.scrape "alloy_self" {
      targets = [{
        "__address__"      = "127.0.0.1:12345",
        "__metrics_path__" = "/metrics",
        "job"              = "alloy",
      }]
      forward_to      = [prometheus.remote_write.sink.receiver]
      scrape_interval = "15s"
    }
  EOT
}

resource "fleet_pipeline" "edge_metrics" {
  name    = "edge-metrics"
  enabled = true
  selector = {
    role = "edge"
  }
  # Loading from a sibling file is usually cleaner for real fragments.
  content = file("${path.module}/pipelines/edge-metrics.alloy")
}

# ---------------------------------------------------------------------------
# Read-only data — handy for assertions and reporting.

data "fleet_pipelines" "all" {}

data "fleet_collectors" "all" {}

output "pipeline_count" {
  value = length(data.fleet_pipelines.all.pipelines)
}

output "applied_collectors" {
  description = "Collector IDs whose last reported status is APPLIED."
  value = [
    for c in data.fleet_collectors.all.collectors :
    c.id if c.last_status == "APPLIED"
  ]
}

# ---------------------------------------------------------------------------
# Identity / RBAC — per-Alloy api token issuance.
#
# This block shows the recommended pattern for replacing the legacy shared
# AGENT_BEARER_TOKEN with one bearer per collector. Each Alloy instance gets
# a token bound to the built-in `agent` role (only `collectors.poll`).
#
# To run this section, you need a manager build that includes the
# `collectors.poll` permission (the migration ships built-in). For older
# managers, omit these resources and keep using AGENT_BEARER_TOKEN.

# Look up the built-in role ids by name. Refreshed on every plan, so newly
# added custom roles are visible immediately.
data "fleet_roles" "all" {}

# A service-account user that owns the per-host token. The password is set
# but never used — the user only ever authenticates via the api token below.
resource "fleet_user" "edge_host_01" {
  email    = "edge-host-01@fleet.local"
  name     = "edge-host-01"
  password = "rotate-me-then-forget" # never used at runtime; keep out of VCS
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

resource "fleet_api_token" "edge_host_01" {
  name     = "edge-host-01"
  user_id  = fleet_user.edge_host_01.id
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

# Plaintext is only ever returned ONCE (on Create). Pipe it into your secret
# store / Helm values / cloud-init template via a sensitive output.
output "edge_host_01_token" {
  description = "Bearer for /etc/alloy/bootstrap.alloy on edge-host-01. Treat as secret."
  value       = fleet_api_token.edge_host_01.token
  sensitive   = true
}
