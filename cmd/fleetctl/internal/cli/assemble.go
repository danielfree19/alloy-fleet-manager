package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newAssembleCmd(g *globalOpts) *cobra.Command {
	var attrs []string
	cmd := &cobra.Command{
		Use:   "assemble",
		Short: "Preview the assembled Alloy config for a hypothetical collector",
		Long: `Ask the Fleet Manager what config it WOULD serve to a collector reporting
the given attributes. Side-effect free — does not touch the collectors table.

Example:
  fleetctl assemble --attr env=prod --attr role=edge`,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			parsed, err := parseKeyValues(attrs)
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			out, err := client.Assemble(ctx, parsed)
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), out)
			}
			w := cmd.OutOrStdout()
			fmt.Fprintf(w, "# hash:      %s\n", out.Hash)
			fmt.Fprintf(w, "# pipelines: %v\n", out.PipelineNames)
			fmt.Fprintln(w, "# --- content ---")
			fmt.Fprintln(w, out.Content)
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&attrs, "attr", nil, "Attribute key=value (repeatable)")
	return cmd
}
