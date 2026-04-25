package cli

import (
	"fmt"
	"net/url"
	"strconv"

	"github.com/spf13/cobra"
)

func newAuditCmd(g *globalOpts) *cobra.Command {
	var (
		targetKind string
		targetID   string
		action     string
		actor      string
		before     string
		limit      int
	)
	cmd := &cobra.Command{
		Use:   "audit",
		Short: "Query the admin audit log",
		Long: `List audit events, most recent first. Flags map 1:1 onto
the manager's GET /audit query string.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			q := url.Values{}
			if targetKind != "" {
				q.Set("target_kind", targetKind)
			}
			if targetID != "" {
				q.Set("target_id", targetID)
			}
			if action != "" {
				q.Set("action", action)
			}
			if actor != "" {
				q.Set("actor", actor)
			}
			if before != "" {
				q.Set("before", before)
			}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			ctx, cancel := g.ctx()
			defer cancel()
			events, err := client.ListAudit(ctx, q)
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), events)
			}
			t := newTable("TIME", "ACTOR", "ACTION", "TARGET", "DETAIL")
			for _, e := range events {
				detail := ""
				if fields, ok := e.Metadata["changed_fields"]; ok {
					detail = fmt.Sprintf("changed=%v", fields)
				}
				t.add(
					e.CreatedAt,
					e.Actor,
					e.Action,
					derefStr(e.TargetName, derefStr(e.TargetID, "—")),
					detail,
				)
			}
			t.write(cmd.OutOrStdout())
			return nil
		},
	}
	cmd.Flags().StringVar(&targetKind, "target-kind", "", "Filter by target kind (e.g. pipeline)")
	cmd.Flags().StringVar(&targetID, "target-id", "", "Filter by target id")
	cmd.Flags().StringVar(&action, "action", "", "Filter by action (pipeline.create|update|delete)")
	cmd.Flags().StringVar(&actor, "actor", "", "Filter by actor substring")
	cmd.Flags().StringVar(&before, "before", "", "RFC3339 cursor (return events strictly older)")
	cmd.Flags().IntVar(&limit, "limit", 100, "Maximum number of events to return (1..500)")
	return cmd
}
