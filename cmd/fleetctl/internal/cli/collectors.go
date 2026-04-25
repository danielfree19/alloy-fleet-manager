package cli

import (
	"github.com/spf13/cobra"
)

func newCollectorsCmd(g *globalOpts) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "collectors",
		Short: "Inspect Alloy collectors registered via remotecfg",
	}
	cmd.AddCommand(newCollectorsListCmd(g))
	return cmd
}

func newCollectorsListCmd(g *globalOpts) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List every collector the manager has observed",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			cs, err := client.ListCollectors(ctx)
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), cs)
			}
			t := newTable("ID", "STATUS", "ATTRIBUTES", "LAST-HASH", "LAST-SEEN")
			for _, c := range cs {
				hash := derefStr(c.LastHashServed, "—")
				if len(hash) > 10 {
					hash = hash[:10]
				}
				t.add(
					c.ID,
					derefStr(c.LastStatus, "—"),
					truncate(formatLabels(c.LocalAttributes), 50),
					hash,
					derefStr(c.LastSeen, "—"),
				)
			}
			t.write(cmd.OutOrStdout())
			return nil
		},
	}
}
