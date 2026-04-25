package cli

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
)

func newValidateCmd(g *globalOpts) *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate an Alloy fragment against the manager's strict validator",
		Long: `Reads Alloy river content from a file (or stdin) and sends it to the
manager's /pipelines/validate endpoint. Exits non-zero on failure, so it can
gate a 'terraform plan' or a git pre-commit hook.

Examples:
  fleetctl validate -f pipelines/edge-metrics.alloy
  cat my.alloy | fleetctl validate`,
		RunE: func(cmd *cobra.Command, args []string) error {
			var content []byte
			var err error
			if file != "" && file != "-" {
				content, err = os.ReadFile(file)
			} else {
				content, err = io.ReadAll(cmd.InOrStdin())
			}
			if err != nil {
				return fmt.Errorf("read input: %w", err)
			}
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			res, err := client.Validate(ctx, string(content))
			if err != nil {
				return err
			}
			if g.output == "json" {
				if err := emitJSON(cmd.OutOrStdout(), res); err != nil {
					return err
				}
			} else {
				engine := res.Engine
				if engine == "" {
					engine = "unknown"
				}
				if res.Valid {
					fmt.Fprintf(cmd.OutOrStdout(), "valid (engine=%s)\n", engine)
				} else {
					fmt.Fprintf(cmd.ErrOrStderr(), "invalid (engine=%s)\n", engine)
					for _, e := range res.Errors {
						fmt.Fprintf(cmd.ErrOrStderr(), "  - %s\n", e)
					}
				}
			}
			if !res.Valid {
				// Signal failure to shell / CI with a distinct exit code via
				// SilenceErrors so cobra doesn't double-print.
				cmd.SilenceUsage = true
				return fmt.Errorf("validation failed")
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "Path to an Alloy fragment (use '-' or omit for stdin)")
	return cmd
}
