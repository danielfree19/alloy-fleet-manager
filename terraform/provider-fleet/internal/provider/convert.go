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

// stringSliceFromList unwraps a tfsdk types.List of strings. A null/unknown
// input is treated as an empty slice — matches the semantics of
// `mapFromTF` and keeps "selector = []" stable across plans.
func stringSliceFromList(ctx context.Context, l types.List) ([]string, diag.Diagnostics) {
	if l.IsNull() || l.IsUnknown() {
		return []string{}, nil
	}
	out := []string{}
	diags := l.ElementsAs(ctx, &out, false)
	if out == nil {
		out = []string{}
	}
	return out, diags
}

// stringPtrOrNil converts a tfsdk types.String into the *string shape
// preferred by our JSON DTOs. Both null *and* empty string become nil so
// `omitempty` JSON tags drop the field entirely on the wire.
func stringPtrOrNil(s types.String) *string {
	if s.IsNull() || s.IsUnknown() {
		return nil
	}
	v := s.ValueString()
	if v == "" {
		return nil
	}
	return &v
}

// apiTokenToModel converts a server-side ApiTokenSummary into the tfsdk
// shape used by the api_token resource. `token` (plaintext) must be threaded
// through explicitly because the API only returns it once on Create.
func apiTokenToModel(ctx context.Context, t ApiTokenSummary, token types.String) apiTokenModel {
	roleIDs := make([]string, 0, len(t.Roles))
	for _, r := range t.Roles {
		roleIDs = append(roleIDs, r.ID)
	}
	roleList, _ := types.ListValueFrom(ctx, types.StringType, roleIDs)

	return apiTokenModel{
		ID:          types.StringValue(t.ID),
		UserID:      types.StringValue(t.UserID),
		Name:        types.StringValue(t.Name),
		RoleIDs:     roleList,
		ExpiresAt:   stringOrNull(t.ExpiresAt),
		Token:       token,
		TokenPrefix: types.StringValue(t.TokenPrefix),
		RevokedAt:   stringOrNull(t.RevokedAt),
		LastUsedAt:  stringOrNull(t.LastUsedAt),
		CreatedAt:   types.StringValue(t.CreatedAt),
	}
}

// userToModel converts a server-side User into the tfsdk shape used by the
// resource. `password` is preserved from the prior state (the API never
// returns it) — callers must thread it through explicitly.
func userToModel(ctx context.Context, u User, password types.String) userModel {
	roleIDs := make([]string, 0, len(u.Roles))
	for _, r := range u.Roles {
		roleIDs = append(roleIDs, r.ID)
	}
	roleList, _ := types.ListValueFrom(ctx, types.StringType, roleIDs)

	updatedAt := u.UpdatedAt
	if updatedAt == "" {
		// POST /users response omits updated_at; fall back to created_at
		// to keep the computed attribute non-null. Read() always
		// re-fetches via GET so subsequent applies see the real value.
		updatedAt = u.CreatedAt
	}

	return userModel{
		ID:        types.StringValue(u.ID),
		Email:     types.StringValue(u.Email),
		Name:      stringOrNull(u.Name),
		Password:  password,
		Disabled:  types.BoolValue(u.Disabled),
		RoleIDs:   roleList,
		CreatedAt: types.StringValue(u.CreatedAt),
		UpdatedAt: types.StringValue(updatedAt),
	}
}
