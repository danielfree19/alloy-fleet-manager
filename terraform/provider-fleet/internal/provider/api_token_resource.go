package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"
)

// fleet_api_token mints a long-lived `fmt_…` bearer token bound to one or
// more RBAC roles. The headline use case is per-Alloy authentication: bind
// the token to the built-in `agent` role (only `collectors.poll`) and drop
// the plaintext into `bootstrap.alloy`'s `remotecfg { bearer_token = … }`.
//
//	resource "fleet_api_token" "edge" {
//	  name     = "edge-host-01"
//	  user_id  = fleet_user.edge.id
//	  role_ids = [data.fleet_roles.all.by_name["agent"]]
//	}
//
//	output "edge_token" {
//	  value     = fleet_api_token.edge.token
//	  sensitive = true
//	}
//
// Important caveats — read these before deploying:
//
//  1. Plaintext is only returned ONCE, by `POST /tokens`. The provider stores
//     it in Terraform state as a sensitive value. Anyone with read access to
//     state can recover the bearer. Use a remote backend with state
//     encryption (S3 + KMS, Terraform Cloud, …) before scaling this out.
//  2. There is no in-place update path on the manager — every attribute
//     change rotates the token (RequiresReplace). For role swaps, this is the
//     safer behaviour: rotation reissues from scratch, the old token is
//     revoked-on-destroy, and `terraform apply` is the audit trail.
//  3. The resource Read path refreshes lifecycle metadata
//     (`last_used_at`, `revoked_at`) so `terraform plan` will surface
//     drift if a token is revoked out-of-band — at which point the next
//     apply rotates it.

var (
	_ resource.Resource                = (*apiTokenResource)(nil)
	_ resource.ResourceWithConfigure   = (*apiTokenResource)(nil)
	_ resource.ResourceWithImportState = (*apiTokenResource)(nil)
)

type apiTokenResource struct {
	client *Client
}

func NewApiTokenResource() resource.Resource {
	return &apiTokenResource{}
}

type apiTokenModel struct {
	ID          types.String `tfsdk:"id"`
	UserID      types.String `tfsdk:"user_id"`
	Name        types.String `tfsdk:"name"`
	RoleIDs     types.List   `tfsdk:"role_ids"`
	ExpiresAt   types.String `tfsdk:"expires_at"`
	Token       types.String `tfsdk:"token"`
	TokenPrefix types.String `tfsdk:"token_prefix"`
	RevokedAt   types.String `tfsdk:"revoked_at"`
	LastUsedAt  types.String `tfsdk:"last_used_at"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

func (r *apiTokenResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_api_token"
}

func (r *apiTokenResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A long-lived bearer api token (`fmt_…`) bound to RBAC roles. Use the built-in `agent` role for per-Alloy `remotecfg` tokens; use `editor` / `viewer` / custom roles for fleetctl, CI, or scripting tokens.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned UUID.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"user_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "User that owns the token. The token's effective permissions are the intersection of `role_ids` and the owner's roles. " +
					"When the provider authenticates as the env `ADMIN_TOKEN` (no user identity), this attribute is mandatory.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Human-readable label, e.g. `edge-host-01`. Surfaced in audit logs and the admin UI.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"role_ids": schema.ListAttribute{
				Required:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Role ids carried by the token. For per-Alloy use: `[data.fleet_roles.all.by_name[\"agent\"]]`. Each id must already be assigned to the owning user (privilege containment is enforced server-side).",
				PlanModifiers:       []planmodifier.List{listplanmodifier.RequiresReplace()},
			},
			"expires_at": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "RFC3339 expiry timestamp; omit for non-expiring tokens. Cannot be edited in place — change forces rotation.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"token": schema.StringAttribute{
				Computed:            true,
				Sensitive:           true,
				MarkdownDescription: "Plaintext bearer. Only set on Create; never refreshed (the manager cannot reveal it again). Persist via a sensitive output if downstream resources need it.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"token_prefix": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "First few chars of the bearer (e.g. `fmt_abc12`). Safe to display in logs and dashboards; matches the `token_prefix` column in `audit_events.metadata`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"revoked_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Set out-of-band when the token is revoked via the UI or API. If non-null after a refresh, the next apply will recreate the resource.",
			},
			"last_used_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Last time the manager accepted this bearer. Updated by both admin api calls and Alloy `remotecfg` polls — useful as an Alloy liveness signal.",
			},
			"created_at": schema.StringAttribute{Computed: true},
		},
	}
}

func (r *apiTokenResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *Client, got %T", req.ProviderData))
		return
	}
	r.client = c
}

// ---- CRUD -------------------------------------------------------------------

func (r *apiTokenResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan apiTokenModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	roleIDs, diags := stringSliceFromList(ctx, plan.RoleIDs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	if len(roleIDs) == 0 {
		resp.Diagnostics.AddAttributeError(
			path.Root("role_ids"),
			"role_ids cannot be empty",
			"An api token must carry at least one role. For Alloy use `data.fleet_roles.<n>.by_name[\"agent\"]`.",
		)
		return
	}

	in := CreateApiTokenInput{
		Name:      plan.Name.ValueString(),
		UserID:    stringPtrOrNil(plan.UserID),
		RoleIDs:   roleIDs,
		ExpiresAt: stringPtrOrNil(plan.ExpiresAt),
	}

	created, err := r.client.CreateApiToken(ctx, in)
	if err != nil {
		resp.Diagnostics.AddError("Create api token failed", err.Error())
		return
	}
	tflog.Info(ctx, "api token created", map[string]any{
		"id":           created.ApiToken.ID,
		"name":         created.ApiToken.Name,
		"user_id":      created.ApiToken.UserID,
		"token_prefix": created.ApiToken.TokenPrefix,
	})

	state := apiTokenToModel(ctx, created.ApiToken, types.StringValue(created.Token))
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *apiTokenResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state apiTokenModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Defensive guard: if state somehow holds an empty ID (e.g. a prior
	// `apply` was interrupted between Create and the consistency check, or
	// state was hand-edited), GET /tokens/<empty> would 500 with a Postgres
	// uuid-cast error and stall every subsequent plan with no recovery
	// path short of `terraform state rm`. Treat empty IDs as "resource
	// gone" so the next plan recreates it cleanly.
	id := state.ID.ValueString()
	if state.ID.IsNull() || state.ID.IsUnknown() || id == "" {
		tflog.Warn(ctx, "api_token state has empty id; removing from state for clean recreate")
		resp.State.RemoveResource(ctx)
		return
	}

	t, err := r.client.GetApiToken(ctx, id)
	if err != nil {
		if IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Read api token failed", err.Error())
		return
	}
	// Preserve plaintext from prior state — the API never returns it.
	next := apiTokenToModel(ctx, *t, state.Token)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Update is unreachable in practice: every user-facing attribute is marked
// RequiresReplace, so the framework converts edits into Delete+Create.
// We still implement it (no-op) to satisfy the resource.Resource interface
// for the rare case the framework calls it with only computed-attribute
// drift.
func (r *apiTokenResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan apiTokenModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *apiTokenResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state apiTokenModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.RevokeApiToken(ctx, state.ID.ValueString()); err != nil {
		if IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Revoke api token failed", err.Error())
	}
}

// ImportState supports `terraform import fleet_api_token.foo <uuid>`. There
// is no name-based import path because the plaintext bearer cannot be
// recovered post-creation: a freshly-imported token will have an unknown
// `token` attribute, and any downstream resource that depends on it must
// be considered tainted. Document, don't gate.
func (r *apiTokenResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
