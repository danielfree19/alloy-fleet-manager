package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// fleet_roles exposes the manager's RBAC role catalogue as both a flat list
// and a `by_name` map for ergonomic lookups:
//
//	data "fleet_roles" "all" {}
//
//	resource "fleet_api_token" "edge" {
//	  role_ids = [data.fleet_roles.all.by_name["agent"]]
//	}
//
// Read-only; the data source re-reads on every plan/apply, so newly created
// custom roles show up without any provider work.

var (
	_ datasource.DataSource              = (*rolesDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*rolesDataSource)(nil)
)

type rolesDataSource struct {
	client *Client
}

func NewRolesDataSource() datasource.DataSource {
	return &rolesDataSource{}
}

func (d *rolesDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_roles"
}

func (d *rolesDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *Client, got %T", req.ProviderData))
		return
	}
	d.client = c
}

type roleModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Builtin     types.Bool   `tfsdk:"builtin"`
	Permissions types.List   `tfsdk:"permissions"`
}

type rolesListModel struct {
	Roles  []roleModel `tfsdk:"roles"`
	ByName types.Map   `tfsdk:"by_name"`
}

func (d *rolesDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Read-only list of every RBAC role on the manager. Most operators only use the `by_name` shortcut to look up a built-in role id (`admin`, `editor`, `viewer`, `agent`).",
		Attributes: map[string]schema.Attribute{
			"roles": schema.ListNestedAttribute{
				Computed: true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id":          schema.StringAttribute{Computed: true},
						"name":        schema.StringAttribute{Computed: true},
						"description": schema.StringAttribute{Computed: true},
						"builtin":     schema.BoolAttribute{Computed: true},
						"permissions": schema.ListAttribute{
							Computed:    true,
							ElementType: types.StringType,
						},
					},
				},
			},
			"by_name": schema.MapAttribute{
				Computed:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Map of `role_name` → `role_id`. Use this in `role_ids = [data.fleet_roles.all.by_name[\"agent\"]]`.",
			},
		},
	}
}

func (d *rolesDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	roles, err := d.client.ListRoles(ctx)
	if err != nil {
		resp.Diagnostics.AddError("List roles failed", err.Error())
		return
	}

	byName := make(map[string]string, len(roles))
	out := rolesListModel{Roles: make([]roleModel, 0, len(roles))}
	for _, r := range roles {
		perms, _ := types.ListValueFrom(ctx, types.StringType, r.Permissions)
		out.Roles = append(out.Roles, roleModel{
			ID:          types.StringValue(r.ID),
			Name:        types.StringValue(r.Name),
			Description: stringOrNull(r.Description),
			Builtin:     types.BoolValue(r.Builtin),
			Permissions: perms,
		})
		byName[r.Name] = r.ID
	}
	mapVal, _ := types.MapValueFrom(ctx, types.StringType, byName)
	out.ByName = mapVal

	resp.Diagnostics.Append(resp.State.Set(ctx, &out)...)
}
