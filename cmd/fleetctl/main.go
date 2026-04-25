// fleetctl is the command-line companion to the self-hosted Alloy Fleet Manager.
//
// It targets three workflows:
//   - scripting admin tasks from shell / CI (list, get, delete),
//   - piping Alloy fragments through the manager's strict validator
//     before a terraform plan or a git commit,
//   - previewing the assembled config for a hypothetical collector
//     (fleetctl assemble --attrs env=prod,role=edge).
//
// For persistent declarative management, prefer the Terraform provider
// or future GitOps sync; this CLI exists for the cases where fighting
// Terraform state for a one-off query is overkill.
package main

import (
	"fmt"
	"os"

	"github.com/fleet-oss/fleetctl/internal/cli"
)

func main() {
	if err := cli.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
