package cli

import (
	"fmt"

	"github.com/fleet-oss/fleetctl/internal/fleetapi"
	"github.com/spf13/cobra"
)

// newCatalogCmd exposes the template catalog surface:
//
//	fleetctl catalog list
//	fleetctl catalog get <id>
//	fleetctl catalog install <id> [--name=...] [--selector k=v ...] [--disabled]
//
// "install" is just GetCatalogTemplate + CreatePipeline wrapped together —
// the same flow the UI uses when you click "Install" on a catalog tile.
func newCatalogCmd(g *globalOpts) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "catalog",
		Short: "Browse and install pipeline templates from the catalog",
	}
	cmd.AddCommand(
		newCatalogListCmd(g),
		newCatalogGetCmd(g),
		newCatalogInstallCmd(g),
	)
	return cmd
}

func newCatalogListCmd(g *globalOpts) *cobra.Command {
	var category string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List catalog templates",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			resp, err := client.ListCatalog(ctx)
			if err != nil {
				return err
			}

			// Optional category filter. Done client-side because the
			// API has no filter params — keeps the server implementation
			// trivial and the CLI's UX unchanged if that ever shifts.
			templates := resp.Templates
			if category != "" {
				filtered := templates[:0:0]
				for _, t := range resp.Templates {
					if t.Category == category {
						filtered = append(filtered, t)
					}
				}
				templates = filtered
			}

			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), struct {
					Sources   []string                          `json:"sources"`
					Templates []fleetapi.CatalogTemplateSummary `json:"templates"`
				}{resp.Sources, templates})
			}
			t := newTable("ID", "CATEGORY", "NAME", "DEFAULT SELECTOR", "TAGS")
			for _, tm := range templates {
				t.add(tm.ID, tm.Category, tm.Name, truncate(formatLabels(tm.DefaultSelector), 36), truncate(joinStrings(tm.Tags, ","), 30))
			}
			t.write(cmd.OutOrStdout())
			return nil
		},
	}
	cmd.Flags().StringVar(&category, "category", "", "Filter by category: metrics | logs | traces | sinks | infra")
	return cmd
}

func newCatalogGetCmd(g *globalOpts) *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a single template (including Alloy content)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()
			t, err := client.GetCatalogTemplate(ctx, args[0])
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), t)
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "ID:               %s\n", t.ID)
			fmt.Fprintf(out, "Name:             %s\n", t.Name)
			fmt.Fprintf(out, "Category:         %s\n", t.Category)
			fmt.Fprintf(out, "Tags:             %s\n", joinStrings(t.Tags, ", "))
			fmt.Fprintf(out, "Default selector: %s\n", formatLabels(t.DefaultSelector))
			fmt.Fprintf(out, "Suggested name:   %s\n", derefStr(t.SuggestedName, "(unset)"))
			fmt.Fprintf(out, "Docs:             %s\n", derefStr(t.DocsURL, "(none)"))
			fmt.Fprintln(out, "")
			fmt.Fprintln(out, "Description:")
			fmt.Fprintln(out, "  "+t.Description)
			if len(t.Requires) > 0 {
				fmt.Fprintln(out, "")
				fmt.Fprintln(out, "Requires:")
				for _, r := range t.Requires {
					fmt.Fprintln(out, "  - "+r)
				}
			}
			fmt.Fprintln(out, "")
			fmt.Fprintln(out, "--- Content ---")
			fmt.Fprintln(out, t.Content)
			return nil
		},
	}
}

func newCatalogInstallCmd(g *globalOpts) *cobra.Command {
	var name string
	var selectorPairs []string
	var disabled bool
	cmd := &cobra.Command{
		Use:   "install <id>",
		Short: "Create a new pipeline from a catalog template",
		Long: "Fetches the template by id and POSTs a new pipeline. Name and selector\n" +
			"default to the template's suggestions but can be overridden via flags.\n" +
			"The pipeline's `content` is never modified at install time — edit it\n" +
			"afterwards with `fleetctl pipelines get` + PATCH, or in the UI.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := g.client()
			if err != nil {
				return err
			}
			ctx, cancel := g.ctx()
			defer cancel()

			t, err := client.GetCatalogTemplate(ctx, args[0])
			if err != nil {
				return err
			}

			pipelineName := name
			if pipelineName == "" {
				if t.SuggestedName != nil {
					pipelineName = *t.SuggestedName
				} else {
					pipelineName = t.ID
				}
			}

			// --selector k=v overrides the template's default. We
			// deliberately don't merge partial overrides with the template
			// defaults: selector targeting is subtle enough that "this is
			// the full selector" is the clearest mental model.
			selector := t.DefaultSelector
			if len(selectorPairs) > 0 {
				parsed, err := parseKeyValues(selectorPairs)
				if err != nil {
					return err
				}
				selector = parsed
			}

			in := fleetapi.CreatePipelineInput{
				Name:     pipelineName,
				Selector: selector,
				Enabled:  !disabled,
				Content:  t.Content,
			}
			p, err := client.CreatePipeline(ctx, in)
			if err != nil {
				return err
			}
			if g.output == "json" {
				return emitJSON(cmd.OutOrStdout(), p)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "installed %q from template %q (id=%s, hash=%s)\n",
				p.Name, t.ID, p.ID, shortStr(p.CurrentHash, 10))
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "Override the pipeline name (default: template.suggested_name or template.id)")
	cmd.Flags().StringSliceVar(&selectorPairs, "selector", nil, "Replace the template's default_selector (repeatable: --selector role=postgres)")
	cmd.Flags().BoolVar(&disabled, "disabled", false, "Create the pipeline in disabled state")
	return cmd
}

func joinStrings(parts []string, sep string) string {
	if len(parts) == 0 {
		return ""
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += sep + p
	}
	return out
}

func shortStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
