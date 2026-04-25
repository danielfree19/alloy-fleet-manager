package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"
)

var (
	_ resource.Resource                = (*pipelineResource)(nil)
	_ resource.ResourceWithImportState = (*pipelineResource)(nil)
	_ resource.ResourceWithConfigure   = (*pipelineResource)(nil)
)

type pipelineResource struct {
	client *Client
}

func NewPipelineResource() resource.Resource {
	return &pipelineResource{}
}

// pipelineModel is the tfsdk-facing projection of a Pipeline. It is kept
// flatter than the server-side PipelineDetail — callers who need version
// history should use a data source; we don't expose it here because
// Terraform plans over history are pure churn.
type pipelineModel struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	Selector       types.Map    `tfsdk:"selector"`
	Enabled        types.Bool   `tfsdk:"enabled"`
	Content        types.String `tfsdk:"content"`
	CurrentVersion types.Int64  `tfsdk:"current_version"`
	CurrentHash    types.String `tfsdk:"current_hash"`
	CreatedAt      types.String `tfsdk:"created_at"`
	UpdatedAt      types.String `tfsdk:"updated_at"`
}

func (r *pipelineResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_pipeline"
}

func (r *pipelineResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A named Alloy config fragment composed into a collector's final config when the selector matches. Every update creates a new immutable `pipeline_versions` row on the server.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned UUID. Stable across renames of the Terraform resource address.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Unique pipeline name. Immutable on the server — changing this forces resource replacement.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
				},
			},
			"selector": schema.MapAttribute{
				Required:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Label selector. The pipeline is delivered to a collector iff every key/value here is present in the collector's `local_attributes`. Empty map applies fleet-wide.",
				PlanModifiers: []planmodifier.Map{
					// Keep a stable null/empty distinction: a present-but-empty
					// map stays present-but-empty across refreshes.
					mapplanmodifier.UseStateForUnknown(),
				},
			},
			"enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "When false, the pipeline is ignored during assembly (without being deleted).",
			},
			"content": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Raw Alloy river fragment. Do not include root-level blocks (`logging`, `tracing`, `remotecfg`) — those belong in the bootstrap config, not in remote-delivered modules.",
			},
			"current_version": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "Server-tracked version counter. Bumped by every save.",
			},
			"current_hash": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "SHA-256 of the current content as computed by the server.",
			},
			"created_at": schema.StringAttribute{Computed: true},
			"updated_at": schema.StringAttribute{Computed: true},
		},
	}
}

func (r *pipelineResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		// Framework calls Configure before provider.Configure during some
		// validation passes — no-op until we have a client.
		return
	}
	client, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *Client, got %T", req.ProviderData))
		return
	}
	r.client = client
}

// ---- CRUD -------------------------------------------------------------------

func (r *pipelineResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan pipelineModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	selector, diags := mapFromTF(ctx, plan.Selector)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	out, err := r.client.CreatePipeline(ctx, CreatePipelineInput{
		Name:     plan.Name.ValueString(),
		Selector: selector,
		Enabled:  plan.Enabled.ValueBool(),
		Content:  plan.Content.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Create pipeline failed", err.Error())
		return
	}
	tflog.Info(ctx, "pipeline created", map[string]any{"id": out.ID, "name": out.Name})

	state := toModel(*out)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *pipelineResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state pipelineModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	detail, err := r.client.GetPipeline(ctx, state.ID.ValueString())
	if err != nil {
		if IsNotFound(err) {
			// Object was deleted out-of-band — drop from state so the next
			// plan proposes a recreate.
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Read pipeline failed", err.Error())
		return
	}

	next := toModel(detail.Pipeline)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *pipelineResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan pipelineModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state pipelineModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	selector, diags := mapFromTF(ctx, plan.Selector)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	enabled := plan.Enabled.ValueBool()
	content := plan.Content.ValueString()

	// Send all three fields on every update. The server is happy to receive
	// a no-op PATCH; sending all fields keeps the code trivial and is still
	// effectively no-op on content/selector when those haven't changed.
	out, err := r.client.UpdatePipeline(ctx, state.ID.ValueString(), UpdatePipelineInput{
		Selector: &selector,
		Enabled:  &enabled,
		Content:  &content,
	})
	if err != nil {
		resp.Diagnostics.AddError("Update pipeline failed", err.Error())
		return
	}

	next := toModel(*out)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *pipelineResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state pipelineModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeletePipeline(ctx, state.ID.ValueString()); err != nil {
		if IsNotFound(err) {
			return // already gone; nothing to do
		}
		resp.Diagnostics.AddError("Delete pipeline failed", err.Error())
	}
}

// ImportState supports both `terraform import fleet_pipeline.foo <uuid>` and
// `terraform import fleet_pipeline.foo name=<name>`. The second form lets
// operators bring pipelines created via the admin API under Terraform control
// without first looking up the UUID by hand.
func (r *pipelineResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	id := req.ID
	if len(id) > 5 && id[:5] == "name=" {
		name := id[5:]
		pipes, err := r.client.ListPipelines(ctx)
		if err != nil {
			resp.Diagnostics.AddError("Import lookup failed", err.Error())
			return
		}
		for _, p := range pipes {
			if p.Name == name {
				id = p.ID
				break
			}
		}
		if id == req.ID {
			resp.Diagnostics.AddError("Import lookup failed", fmt.Sprintf("no pipeline named %q", name))
			return
		}
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), id)...)
}
