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
