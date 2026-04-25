package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var (
	_ datasource.DataSource              = (*collectorsDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*collectorsDataSource)(nil)
)

type collectorsDataSource struct {
	client *Client
}

func NewCollectorsDataSource() datasource.DataSource {
	return &collectorsDataSource{}
}

func (d *collectorsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_collectors"
}

func (d *collectorsDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
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

type collectorsListModel struct {
	Collectors []collectorModel `tfsdk:"collectors"`
}

type collectorModel struct {
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	LocalAttributes  types.Map    `tfsdk:"local_attributes"`
	LastSeen         types.String `tfsdk:"last_seen"`
	LastStatus       types.String `tfsdk:"last_status"`
	LastError        types.String `tfsdk:"last_error"`
	LastHashServed   types.String `tfsdk:"last_hash_served"`
	CreatedAt        types.String `tfsdk:"created_at"`
	UpdatedAt        types.String `tfsdk:"updated_at"`
}

func (d *collectorsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Read-only list of every collector seen via the remotecfg `CollectorService`. Useful for asserting invariants in CI (\"every `role=edge` collector is currently applied\").",
		Attributes: map[string]schema.Attribute{
			"collectors": schema.ListNestedAttribute{
				Computed: true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id":               schema.StringAttribute{Computed: true},
						"name":             schema.StringAttribute{Computed: true},
						"local_attributes": schema.MapAttribute{Computed: true, ElementType: types.StringType},
						"last_seen":        schema.StringAttribute{Computed: true},
						"last_status":      schema.StringAttribute{Computed: true},
						"last_error":       schema.StringAttribute{Computed: true},
						"last_hash_served": schema.StringAttribute{Computed: true},
						"created_at":       schema.StringAttribute{Computed: true},
						"updated_at":       schema.StringAttribute{Computed: true},
					},
				},
			},
		},
	}
}

func (d *collectorsDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	collectors, err := d.client.ListCollectors(ctx)
	if err != nil {
		resp.Diagnostics.AddError("List collectors failed", err.Error())
		return
	}

	out := collectorsListModel{Collectors: make([]collectorModel, 0, len(collectors))}
	for _, c := range collectors {
		attrs, _ := types.MapValueFrom(ctx, types.StringType, nonNilMap(c.LocalAttributes))
		out.Collectors = append(out.Collectors, collectorModel{
			ID:              types.StringValue(c.ID),
			Name:            stringOrNull(c.Name),
			LocalAttributes: attrs,
			LastSeen:        stringOrNull(c.LastSeen),
			LastStatus:      stringOrNull(c.LastStatus),
			LastError:       stringOrNull(c.LastError),
			LastHashServed:  stringOrNull(c.LastHashServed),
			CreatedAt:       types.StringValue(c.CreatedAt),
			UpdatedAt:       types.StringValue(c.UpdatedAt),
		})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &out)...)
}

func stringOrNull(s *string) types.String {
	if s == nil {
		return types.StringNull()
	}
	return types.StringValue(*s)
}
