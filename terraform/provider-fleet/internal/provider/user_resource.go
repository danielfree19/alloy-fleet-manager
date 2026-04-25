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

// fleet_user manages a local-database user on the Fleet Manager. The most
// common use case in Terraform is "create a service account that owns a
// per-Alloy api token", which composes with `fleet_api_token`:
//
//	resource "fleet_user" "edge" {
//	  email    = "edge-host-01@fleet.local"
//	  name     = "edge-host-01"
//	  password = random_password.edge.result // never used; bound to the agent role
//	  role_ids = [data.fleet_roles.all.by_name["agent"]]
//	}
//
// Notes & trade-offs:
//   - `email` is unique server-side and immutable. Changing it forces a replace.
//   - `password` is sensitive and write-only; the manager never echoes it
//     back, so we treat plan changes as "rotate via /users/:id/password".
//   - DELETE on this resource hits the manager's hard-delete path
//     (`DELETE /users/:id`) — it cascades the user's api_tokens.
//
// We deliberately do NOT expose `oidc_issuer`/`oidc_subject` here: those are
// reserved for SSO-provisioned users and would be confusing to surface
// from a Terraform-managed resource that always represents a *local* user.

var (
	_ resource.Resource                = (*userResource)(nil)
	_ resource.ResourceWithConfigure   = (*userResource)(nil)
	_ resource.ResourceWithImportState = (*userResource)(nil)
)

type userResource struct {
	client *Client
}

func NewUserResource() resource.Resource {
	return &userResource{}
}

type userModel struct {
	ID        types.String `tfsdk:"id"`
	Email     types.String `tfsdk:"email"`
	Name      types.String `tfsdk:"name"`
	Password  types.String `tfsdk:"password"`
	Disabled  types.Bool   `tfsdk:"disabled"`
	RoleIDs   types.List   `tfsdk:"role_ids"`
	CreatedAt types.String `tfsdk:"created_at"`
	UpdatedAt types.String `tfsdk:"updated_at"`
}

func (r *userResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_user"
}

func (r *userResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A local-database user on the Fleet Manager. Most operators only use this to create a service-account user that will own a `fleet_api_token` (notably the per-Alloy `agent`-role token).",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned UUID.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"email": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Unique email/login. Immutable on the server; changing forces a replace.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "Display name. Optional; the manager echoes back null when unset.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"password": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Initial password. Min 8 chars (manager-enforced). " +
					"Optional: pure-API users (e.g. an `agent`-role service account that only ever auths via api tokens) " +
					"can be created with no password, then no one can log in as them. " +
					"Changing this attribute on an existing user calls `POST /users/:id/password` to rotate.",
			},
			"disabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				MarkdownDescription: "When true the user can no longer authenticate; their api_tokens still work until you revoke them. Defaults to false.",
				PlanModifiers:       []planmodifier.Bool{},
			},
			"role_ids": schema.ListAttribute{
				Required:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Role ids assigned to the user. Use `data.fleet_roles.<n>.by_name[\"agent\"]` to bind a service account to the built-in agent role.",
				PlanModifiers:       []planmodifier.List{listplanmodifier.UseStateForUnknown()},
			},
			"created_at": schema.StringAttribute{Computed: true},
			"updated_at": schema.StringAttribute{Computed: true},
		},
	}
}

func (r *userResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
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

func (r *userResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan userModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	roleIDs, diags := stringSliceFromList(ctx, plan.RoleIDs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	in := CreateUserInput{
		Email:    plan.Email.ValueString(),
		Name:     stringPtrOrNil(plan.Name),
		Password: plan.Password.ValueString(),
		RoleIDs:  roleIDs,
		Disabled: plan.Disabled.ValueBool(),
	}
	created, err := r.client.CreateUser(ctx, in)
	if err != nil {
		resp.Diagnostics.AddError("Create user failed", err.Error())
		return
	}
	tflog.Info(ctx, "user created", map[string]any{"id": created.ID, "email": created.Email})

	// POST /users response omits `updated_at` and (when role_ids was empty
	// in the request) inherits no roles. Re-fetch via GET to get the
	// canonical shape.
	full, err := r.client.GetUser(ctx, created.ID)
	if err != nil {
		resp.Diagnostics.AddError("Re-read user after create failed", err.Error())
		return
	}

	state := userToModel(ctx, *full, plan.Password)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *userResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state userModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Defensive guard — see api_token_resource.Read for the rationale.
	id := state.ID.ValueString()
	if state.ID.IsNull() || state.ID.IsUnknown() || id == "" {
		tflog.Warn(ctx, "user state has empty id; removing from state for clean recreate")
		resp.State.RemoveResource(ctx)
		return
	}

	u, err := r.client.GetUser(ctx, id)
	if err != nil {
		if IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Read user failed", err.Error())
		return
	}
	// Preserve password from prior state — it's not readable from the API.
	next := userToModel(ctx, *u, state.Password)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *userResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan userModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state userModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	roleIDs, diags := stringSliceFromList(ctx, plan.RoleIDs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	disabled := plan.Disabled.ValueBool()
	patch := UpdateUserInput{
		Name:     stringPtrOrNil(plan.Name),
		Disabled: &disabled,
		RoleIDs:  &roleIDs,
	}
	if _, err := r.client.UpdateUser(ctx, state.ID.ValueString(), patch); err != nil {
		resp.Diagnostics.AddError("Update user failed", err.Error())
		return
	}

	// Rotate password if the operator changed it. We compare to state, not
	// to the API (the API never echoes password back).
	if !plan.Password.IsNull() && !plan.Password.IsUnknown() &&
		plan.Password.ValueString() != state.Password.ValueString() {
		if err := r.client.do(ctx, "POST", "/users/"+state.ID.ValueString()+"/password",
			map[string]string{"new_password": plan.Password.ValueString()}, nil); err != nil {
			resp.Diagnostics.AddError("Rotate password failed", err.Error())
			return
		}
	}

	full, err := r.client.GetUser(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Re-read user after update failed", err.Error())
		return
	}
	next := userToModel(ctx, *full, plan.Password)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *userResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state userModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteUser(ctx, state.ID.ValueString()); err != nil {
		if IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Delete user failed", err.Error())
	}
}

func (r *userResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	// Allow `terraform import fleet_user.foo email=alice@example.com` in
	// addition to a raw uuid. Operators rarely know user UUIDs by hand.
	id := req.ID
	if len(id) > 6 && id[:6] == "email=" {
		email := id[6:]
		users, err := r.client.ListUsers(ctx)
		if err != nil {
			resp.Diagnostics.AddError("Import lookup failed", err.Error())
			return
		}
		for _, u := range users {
			if u.Email == email {
				id = u.ID
				break
			}
		}
		if id == req.ID {
			resp.Diagnostics.AddError("Import lookup failed", fmt.Sprintf("no user with email %q", email))
			return
		}
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), id)...)
}
