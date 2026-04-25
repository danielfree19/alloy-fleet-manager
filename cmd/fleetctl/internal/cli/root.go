// Package cli wires up the cobra command tree for fleetctl.
//
// Configuration (endpoint + admin token) is resolved in this exact order:
//  1. explicit --endpoint / --token flags,
//  2. FLEET_ENDPOINT / FLEET_ADMIN_TOKEN environment variables,
//  3. (no implicit default) — command fails if still unset.
//
// We intentionally don't read a config file on disk. Operators who want
// persistent settings already have shell dotfiles; adding a ~/.fleetctl.yaml
// just creates another thing to secure.
package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/fleet-oss/fleetctl/internal/fleetapi"
	"github.com/spf13/cobra"
)

const defaultEndpoint = "http://localhost:9090"

type globalOpts struct {
	endpoint string
	token    string
	output   string // "table" (default) or "json"
	timeout  time.Duration
}

func (g *globalOpts) client() (*fleetapi.Client, error) {
	endpoint := g.endpoint
	if endpoint == "" {
		endpoint = os.Getenv("FLEET_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	token := g.token
	if token == "" {
		token = os.Getenv("FLEET_ADMIN_TOKEN")
	}
	if token == "" {
		return nil, fmt.Errorf("no admin token provided: set FLEET_ADMIN_TOKEN or pass --token")
	}
	return fleetapi.NewClient(fleetapi.Options{
		Endpoint:   endpoint,
		AdminToken: token,
		UserAgent:  "fleetctl/0.1.0",
		Timeout:    g.timeout,
	}), nil
}

func (g *globalOpts) ctx() (context.Context, context.CancelFunc) {
	if g.timeout <= 0 {
		return context.WithCancel(context.Background())
	}
	return context.WithTimeout(context.Background(), g.timeout)
}

func NewRootCmd() *cobra.Command {
	g := &globalOpts{}
	root := &cobra.Command{
		Use:           "fleetctl",
		Short:         "CLI companion to the self-hosted Alloy Fleet Manager",
		Long:          "fleetctl queries and inspects a running Fleet Manager. Prefer the Terraform provider for declarative state.",
		SilenceUsage:  true,
		SilenceErrors: false,
	}
	root.PersistentFlags().StringVar(&g.endpoint, "endpoint", "", "Fleet Manager base URL (env FLEET_ENDPOINT; default http://localhost:9090)")
	root.PersistentFlags().StringVar(&g.token, "token", "", "Admin bearer token (env FLEET_ADMIN_TOKEN)")
	root.PersistentFlags().StringVarP(&g.output, "output", "o", "table", "Output format: table | json")
	root.PersistentFlags().DurationVar(&g.timeout, "timeout", 30*time.Second, "HTTP timeout for each API call")

	root.AddCommand(
		newPipelinesCmd(g),
		newCollectorsCmd(g),
		newCatalogCmd(g),
		newAssembleCmd(g),
		newValidateCmd(g),
		newAuditCmd(g),
		newVersionCmd(),
	)
	return root
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print fleetctl version",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintln(cmd.OutOrStdout(), "fleetctl 0.1.0")
		},
	}
}

// parseKeyValues parses a slice like ["env=prod", "role=edge"] into a map.
// Duplicate keys take the last value (matches how `curl -d` behaves and how
// most CLI flag parsers treat repeated values).
func parseKeyValues(pairs []string) (map[string]string, error) {
	out := make(map[string]string, len(pairs))
	for _, p := range pairs {
		i := strings.IndexByte(p, '=')
		if i <= 0 {
			return nil, fmt.Errorf("expected key=value, got %q", p)
		}
		out[strings.TrimSpace(p[:i])] = p[i+1:]
	}
	return out, nil
}
