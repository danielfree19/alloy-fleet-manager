package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

// emitJSON prints v as indented JSON. Used when --output=json.
func emitJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// table renders rows with aligned columns. Keeps the CLI dependency-free
// by using the stdlib text/tabwriter rather than pulling in a TUI crate.
type table struct {
	headers []string
	rows    [][]string
}

func newTable(headers ...string) *table {
	return &table{headers: headers}
}

func (t *table) add(cols ...string) {
	t.rows = append(t.rows, cols)
}

func (t *table) write(w io.Writer) {
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(t.headers, "\t"))
	for _, r := range t.rows {
		// Pad short rows with blanks so tabwriter doesn't misalign.
		if len(r) < len(t.headers) {
			padded := make([]string, len(t.headers))
			copy(padded, r)
			r = padded
		}
		fmt.Fprintln(tw, strings.Join(r, "\t"))
	}
	_ = tw.Flush()
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}

// formatLabels renders a map as "k=v, k=v" ordered alphabetically. Used
// for selectors and attribute columns in the table output.
func formatLabels(m map[string]string) string {
	if len(m) == 0 {
		return "—"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// cheap insertion sort — labels rarely exceed a handful of keys.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ", ")
}

func derefStr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}
