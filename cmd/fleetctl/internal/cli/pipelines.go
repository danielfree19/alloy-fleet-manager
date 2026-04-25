package cli

import (
	"fmt"

	"github.com/fleet-oss/fleetctl/internal/fleetapi"
	"github.com/spf13/cobra"
)

func newPipelinesCmd(g *globalOpts) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pipelines",
		Short: "Inspect pipelines managed by the Fleet Manager",
	}
	cmd.AddCommand(
		newPipelinesListCmd(g),
		newPipelinesGetCmd(g),
		newPipelinesDeleteCmd(g),
	)
	return cmd
}

func newPipelinesListCmd(g *globalOpts) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List every pipeline",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			ps, err := client.ListPipelines(ctx)
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), ps)
			}
			t := newTable("NAME", "ENABLED", "VERSION", "HASH", "SELECTOR", "UPDATED")
			for _, p := range ps {
				hash := p.CurrentHash
				if len(hash) > 10 {
					hash = hash[:10]
				}
				t.add(p.Name, boolStr(p.Enabled), fmt.Sprintf("v%d", p.CurrentVersion), hash, truncate(formatLabels(p.Selector), 40), p.UpdatedAt)
			}
			t.write(cmd.OutOrStdout())
			return nil
		},
	}
}

func newPipelinesGetCmd(g *globalOpts) *cobra.Command {
	var byName bool
	cmd := &cobra.Command{
		Use:   "get <id-or-name>",
		Short: "Show a single pipeline (detail + version history)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			ref := args[0]
			var detail *fleetapi.PipelineDetail
			var derr error
			if byName {
				detail, derr = client.GetPipelineByName(ctx, ref)
			} else {
				detail, derr = client.GetPipeline(ctx, ref)
			}
			if derr != nil {
				return derr
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), detail)
			}
			p := detail.Pipeline
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "Name:        %s\n", p.Name)
			fmt.Fprintf(out, "ID:          %s\n", p.ID)
			fmt.Fprintf(out, "Enabled:     %s\n", boolStr(p.Enabled))
			fmt.Fprintf(out, "Version:     v%d\n", p.CurrentVersion)
			fmt.Fprintf(out, "Hash:        %s\n", p.CurrentHash)
			fmt.Fprintf(out, "Selector:    %s\n", formatLabels(p.Selector))
			fmt.Fprintf(out, "Updated:     %s\n", p.UpdatedAt)
			fmt.Fprintln(out, "")
			fmt.Fprintln(out, "--- Content ---")
			fmt.Fprintln(out, p.CurrentContent)
			fmt.Fprintln(out, "--- History ---")
			vt := newTable("VERSION", "HASH", "CREATED")
			for _, v := range detail.Versions {
				h := v.Hash
				if len(h) > 10 {
					h = h[:10]
				}
				vt.add(fmt.Sprintf("v%d", v.Version), h, v.CreatedAt)
			}
			vt.write(out)
			return nil
		},
	}
	cmd.Flags().BoolVar(&byName, "by-name", false, "Treat the argument as a pipeline name instead of an ID")
	return cmd
}

func newPipelinesDeleteCmd(g *globalOpts) *cobra.Command {
	var yes bool
	var byName bool
	cmd := &cobra.Command{
		Use:   "delete <id-or-name>",
		Short: "Delete a pipeline (writes a pipeline.delete audit event)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes {
				return fmt.Errorf("refusing to delete without --yes; this is irreversible")
			}
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			id := args[0]
			if byName {
				d, err := client.GetPipelineByName(ctx, id)
				if err != nil {
					return err
				}
				id = d.Pipeline.ID
			}
			if err := client.DeletePipeline(ctx, id); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "deleted", id)
			return nil
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm the deletion")
	cmd.Flags().BoolVar(&byName, "by-name", false, "Treat the argument as a pipeline name instead of an ID")
	return cmd
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

