package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var (
	_ datasource.DataSource              = (*pipelinesDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*pipelinesDataSource)(nil)
)

type pipelinesDataSource struct {
	client *Client
}

func NewPipelinesDataSource() datasource.DataSource {
	return &pipelinesDataSource{}
}

func (d *pipelinesDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_pipelines"
}

func (d *pipelinesDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
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

// pipelinesListModel intentionally omits the `content` blob — listing 100
// pipelines with their full Alloy fragments is heavy and not what this data
// source is for. Use `data.fleet_pipeline.<name>` to pull content.
type pipelinesListModel struct {
	Pipelines []pipelineSummary `tfsdk:"pipelines"`
}

type pipelineSummary struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	Selector       types.Map    `tfsdk:"selector"`
	Enabled        types.Bool   `tfsdk:"enabled"`
	CurrentVersion types.Int64  `tfsdk:"current_version"`
	CurrentHash    types.String `tfsdk:"current_hash"`
	UpdatedAt      types.String `tfsdk:"updated_at"`
}

var pipelineSummaryTypes = map[string]attr.Type{
	"id":              types.StringType,
	"name":            types.StringType,
	"selector":        types.MapType{ElemType: types.StringType},
	"enabled":         types.BoolType,
	"current_version": types.Int64Type,
	"current_hash":    types.StringType,
	"updated_at":      types.StringType,
}

func (d *pipelinesDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "List every pipeline on the manager (metadata only — no content).",
		Attributes: map[string]schema.Attribute{
			"pipelines": schema.ListNestedAttribute{
				Computed: true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id":              schema.StringAttribute{Computed: true},
						"name":            schema.StringAttribute{Computed: true},
						"selector":        schema.MapAttribute{Computed: true, ElementType: types.StringType},
						"enabled":         schema.BoolAttribute{Computed: true},
						"current_version": schema.Int64Attribute{Computed: true},
						"current_hash":    schema.StringAttribute{Computed: true},
						"updated_at":      schema.StringAttribute{Computed: true},
					},
				},
			},
		},
	}
}

func (d *pipelinesDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	pipes, err := d.client.ListPipelines(ctx)
	if err != nil {
		resp.Diagnostics.AddError("List pipelines failed", err.Error())
		return
	}

	out := pipelinesListModel{Pipelines: make([]pipelineSummary, 0, len(pipes))}
	for _, p := range pipes {
		sel, _ := types.MapValueFrom(ctx, types.StringType, nonNilMap(p.Selector))
		out.Pipelines = append(out.Pipelines, pipelineSummary{
			ID:             types.StringValue(p.ID),
			Name:           types.StringValue(p.Name),
			Selector:       sel,
			Enabled:        types.BoolValue(p.Enabled),
			CurrentVersion: types.Int64Value(p.CurrentVersion),
			CurrentHash:    types.StringValue(p.CurrentHash),
			UpdatedAt:      types.StringValue(p.UpdatedAt),
		})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &out)...)
}

func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
