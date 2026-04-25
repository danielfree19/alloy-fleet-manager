package provider

import (
	"context"
	"os"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Ensure the provider implements the interfaces the framework expects at
// compile time — catches schema drift early.
var _ provider.Provider = (*fleetProvider)(nil)

type fleetProvider struct {
	version string
}

// New returns a provider factory bound to `version`. Used by main.go when
// serving and by acceptance tests.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &fleetProvider{version: version}
	}
}

// providerModel mirrors the HCL block in `provider "fleet" {}` blocks.
type providerModel struct {
	Endpoint   types.String `tfsdk:"endpoint"`
	AdminToken types.String `tfsdk:"admin_token"`
}

func (p *fleetProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "fleet"
	resp.Version = p.version
}

func (p *fleetProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manage a self-hosted Alloy Fleet Manager: pipelines and read-only views of collectors.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				MarkdownDescription: "Base URL of the Fleet Manager API, e.g. `http://localhost:9090`. Env: `FLEET_ENDPOINT`.",
				Optional:            true,
			},
			"admin_token": schema.StringAttribute{
				MarkdownDescription: "Admin bearer token (matches `ADMIN_TOKEN` on the manager). Env: `FLEET_ADMIN_TOKEN`.",
				Optional:            true,
				Sensitive:           true,
			},
		},
	}
}

func (p *fleetProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var data providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &data)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Precedence: explicit HCL value > env var > hard-coded default. This
	// matches the convention every other HashiCorp provider uses and makes
	// CI-friendly usage trivial (just set env vars).
	endpoint := strings.TrimSpace(data.Endpoint.ValueString())
	if endpoint == "" {
		endpoint = os.Getenv("FLEET_ENDPOINT")
	}
	if endpoint == "" {
		endpoint = "http://localhost:9090"
	}

	token := strings.TrimSpace(data.AdminToken.ValueString())
	if token == "" {
		token = os.Getenv("FLEET_ADMIN_TOKEN")
	}

	if token == "" {
		resp.Diagnostics.AddError(
			"Missing admin token",
			"Set `admin_token` in the provider block, or export FLEET_ADMIN_TOKEN. The Fleet Manager refuses every /pipelines request without it.",
		)
		return
	}

	client := NewClient(endpoint, token, "terraform-provider-fleet/"+p.version)
	// The framework gives the same client to every resource and data source.
	resp.ResourceData = client
	resp.DataSourceData = client
}

func (p *fleetProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewPipelineResource,
	}
}

func (p *fleetProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewPipelineDataSource,
		NewPipelinesDataSource,
		NewCollectorsDataSource,
	}
}
