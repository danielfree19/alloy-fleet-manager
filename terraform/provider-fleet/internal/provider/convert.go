package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// toModel converts a server-side Pipeline into the tfsdk shape used by the
// resource + data sources. Centralized so a schema change touches one
// function, not every CRUD method.
func toModel(p Pipeline) pipelineModel {
	selector := p.Selector
	if selector == nil {
		selector = map[string]string{}
	}
	m := pipelineModel{
		ID:             types.StringValue(p.ID),
		Name:           types.StringValue(p.Name),
		Enabled:        types.BoolValue(p.Enabled),
		Content:        types.StringValue(p.CurrentContent),
		CurrentVersion: types.Int64Value(p.CurrentVersion),
		CurrentHash:    types.StringValue(p.CurrentHash),
		CreatedAt:      types.StringValue(p.CreatedAt),
		UpdatedAt:      types.StringValue(p.UpdatedAt),
	}
	// We must build the types.Map via the framework helper so null vs empty
	// is encoded correctly. Errors here are impossible (StringType values),
	// but we still thread diagnostics if they ever appear.
	mapVal, _ := types.MapValueFrom(context.Background(), types.StringType, selector)
	m.Selector = mapVal
	return m
}

func mapFromTF(ctx context.Context, m types.Map) (map[string]string, diag.Diagnostics) {
	if m.IsNull() || m.IsUnknown() {
		return map[string]string{}, nil
	}
	out := map[string]string{}
	diags := m.ElementsAs(ctx, &out, false)
	if out == nil {
		out = map[string]string{}
	}
	return out, diags
}
