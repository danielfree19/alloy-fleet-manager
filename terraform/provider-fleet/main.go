// Package main is the entry point for the Fleet Manager Terraform provider.
//
// Build:
//
//	go build -o terraform-provider-fleet
//
// Then either `go install` or wire into $HOME/.terraformrc via `dev_overrides`
// (see docs/terraform.md).
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/fleet-oss/terraform-provider-fleet/internal/provider"
)

// version is set via -ldflags at release time. For local development the
// default ("dev") is fine — Terraform only echoes this back in `terraform
// version` output.
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "start in delve-compatible debug mode")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		// The address here matches the `terraform { required_providers {} }`
		// block in example configurations and the dev_override entry. Bumping
		// this is a breaking change for existing Terraform states.
		Address: "registry.terraform.io/fleet-oss/fleet",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
