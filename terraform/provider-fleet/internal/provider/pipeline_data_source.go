package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var (
	_ datasource.DataSource              = (*pipelineDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*pipelineDataSource)(nil)
)

type pipelineDataSource struct {
	client *Client
}

func NewPipelineDataSource() datasource.DataSource {
	return &pipelineDataSource{}
}

func (d *pipelineDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_pipeline"
}

func (d *pipelineDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
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

func (d *pipelineDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Lookup a single pipeline by either its `id` or `name`. Exactly one of the two must be set.",
		Attributes: map[string]schema.Attribute{
			"id":              schema.StringAttribute{Optional: true, Computed: true},
			"name":            schema.StringAttribute{Optional: true, Computed: true},
			"selector":        schema.MapAttribute{Computed: true, ElementType: types.StringType},
			"enabled":         schema.BoolAttribute{Computed: true},
			"content":         schema.StringAttribute{Computed: true},
			"current_version": schema.Int64Attribute{Computed: true},
			"current_hash":    schema.StringAttribute{Computed: true},
			"created_at":      schema.StringAttribute{Computed: true},
			"updated_at":      schema.StringAttribute{Computed: true},
		},
	}
}

func (d *pipelineDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg pipelineModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	hasID := !cfg.ID.IsNull() && cfg.ID.ValueString() != ""
	hasName := !cfg.Name.IsNull() && cfg.Name.ValueString() != ""
	if hasID == hasName {
		resp.Diagnostics.AddError("Invalid lookup", "Set exactly one of `id` or `name`.")
		return
	}

	var p *Pipeline
	if hasID {
		detail, err := d.client.GetPipeline(ctx, cfg.ID.ValueString())
		if err != nil {
			resp.Diagnostics.AddError("Read pipeline failed", err.Error())
			return
		}
		p = &detail.Pipeline
	} else {
		name := cfg.Name.ValueString()
		pipes, err := d.client.ListPipelines(ctx)
		if err != nil {
			resp.Diagnostics.AddError("Read pipeline failed", err.Error())
			return
		}
		for i := range pipes {
			if pipes[i].Name == name {
				p = &pipes[i]
				break
			}
		}
		if p == nil {
			resp.Diagnostics.AddError("Pipeline not found", fmt.Sprintf("no pipeline named %q", name))
			return
		}
	}

	state := toModel(*p)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}
