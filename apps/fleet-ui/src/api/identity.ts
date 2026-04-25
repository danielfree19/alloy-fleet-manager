/**
 * Thin clients for the /users, /roles, /tokens, /auth surfaces.
 * Same conventions as `api/pipelines.ts` etc — every function returns
 * a typed payload and lets ApiError bubble up.
 */
import { apiFetch } from "./client";
import type {
  ApiToken,
  CreateApiTokenResponse,
  Permission,
  Role,
  User,
} from "./types";

// ---- /auth ----------------------------------------------------------------

export async function changeOwnPassword(
  current_password: string,
  new_password: string,
): Promise<void> {
  await apiFetch("/auth/password", {
    method: "POST",
    body: { current_password, new_password },
  });
}

// ---- /users ---------------------------------------------------------------

export async function listUsers(): Promise<User[]> {
  const r = await apiFetch<{ users: User[] }>("/users");
  return r.users;
}

export async function getUser(id: string): Promise<User> {
  return apiFetch<User>(`/users/${id}`);
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password?: string;
  role_ids?: string[];
}

export async function createUser(input: CreateUserInput): Promise<User> {
  return apiFetch<User>("/users", { method: "POST", body: input });
}

export interface UpdateUserInput {
  name?: string | null;
  disabled?: boolean;
  role_ids?: string[];
}

export async function updateUser(id: string, patch: UpdateUserInput): Promise<User> {
  return apiFetch<User>(`/users/${id}`, { method: "PATCH", body: patch });
}

export async function resetUserPassword(id: string, new_password: string): Promise<void> {
  await apiFetch(`/users/${id}/password`, {
    method: "POST",
    body: { new_password },
  });
}

export async function deleteUser(id: string): Promise<void> {
  await apiFetch(`/users/${id}`, { method: "DELETE" });
}

// ---- /roles ---------------------------------------------------------------

export async function listRoles(): Promise<Role[]> {
  const r = await apiFetch<{ roles: Role[] }>("/roles");
  return r.roles;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: Permission[];
}

export async function createRole(input: CreateRoleInput): Promise<Role> {
  return apiFetch<Role>("/roles", { method: "POST", body: input });
}

export interface UpdateRoleInput {
  description?: string;
  permissions?: Permission[];
}

export async function updateRole(id: string, patch: UpdateRoleInput): Promise<Role> {
  return apiFetch<Role>(`/roles/${id}`, { method: "PATCH", body: patch });
}

export async function deleteRole(id: string): Promise<void> {
  await apiFetch(`/roles/${id}`, { method: "DELETE" });
}

// ---- /tokens --------------------------------------------------------------

export async function listMyTokens(): Promise<ApiToken[]> {
  const r = await apiFetch<{ tokens: ApiToken[] }>("/tokens?user=me");
  return r.tokens;
}

export async function listTokensForUser(userId: string): Promise<ApiToken[]> {
  const r = await apiFetch<{ tokens: ApiToken[] }>(`/users/${userId}/tokens`);
  return r.tokens;
}

export interface CreateTokenInput {
  name: string;
  user_id?: string;
  role_ids: string[];
  expires_at?: string | null;
}

export async function createToken(input: CreateTokenInput): Promise<CreateApiTokenResponse> {
  return apiFetch<CreateApiTokenResponse>("/tokens", { method: "POST", body: input });
}

export async function revokeToken(id: string): Promise<void> {
  await apiFetch(`/tokens/${id}`, { method: "DELETE" });
}

// ---- SSO ------------------------------------------------------------------
//
// The `/auth/providers` surface is public (returns an empty list when SSO
// is fully disabled) and drives the buttons rendered on the login page.
// All `/sso/...` admin endpoints require `sso.read` (read) or `sso.write`
// (mutations + test-connection); the UI hides those rails entirely from
// actors who lack the gating permission so 403s don't leak through to
// surfaced error toasts.

/** Public list of providers; safe to call before sign-in. */
export interface AuthProviderEntry {
  id: string;
  display_name: string;
  kind: "oidc" | "saml";
}

export async function listAuthProviders(): Promise<AuthProviderEntry[]> {
  const r = await apiFetch<{ providers: AuthProviderEntry[] }>("/auth/providers");
  return r.providers;
}

export interface SsoProviderConfig {
  id: string;
  kind: "oidc" | "saml";
  display_name: string;
  issuer: string | null;
  client_id: string | null;
  /** Always returned masked as "***" when set; `null` when unset. */
  client_secret: string | null;
  redirect_uri: string | null;
  scopes: string[];
  groups_claim: string;
  source: "yaml" | "ui";
  /** group_value -> [role_id, ...] resolved against the seeded role table. */
  role_mappings: Record<string, string[]>;
  created_at: string;
  updated_at: string;
}

export async function listSsoProviders(): Promise<SsoProviderConfig[]> {
  const r = await apiFetch<{ providers: SsoProviderConfig[] }>("/sso/providers");
  return r.providers;
}

export async function getSsoProvider(id: string): Promise<SsoProviderConfig> {
  return apiFetch<SsoProviderConfig>(`/sso/providers/${encodeURIComponent(id)}`);
}

export interface SsoProviderInput {
  id?: string;
  kind?: "oidc";
  display_name?: string;
  issuer?: string;
  client_id?: string;
  /** Send `null` or omit to leave the existing secret untouched on PATCH. */
  client_secret?: string | null;
  redirect_uri?: string;
  scopes?: string[];
  groups_claim?: string;
  /**
   * group_value -> [role_id, ...]. Server validates each id against
   * the seeded `roles` table and rejects unknown ids.
   */
  role_mappings?: Record<string, string[]>;
}

export async function createSsoProvider(input: SsoProviderInput): Promise<SsoProviderConfig> {
  return apiFetch<SsoProviderConfig>("/sso/providers", {
    method: "POST",
    body: input,
  });
}

export async function updateSsoProvider(
  id: string,
  patch: SsoProviderInput,
): Promise<SsoProviderConfig> {
  return apiFetch<SsoProviderConfig>(`/sso/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}

export async function deleteSsoProvider(id: string): Promise<void> {
  await apiFetch(`/sso/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  jwks_keys?: number;
  authorization_endpoint?: string;
  token_endpoint?: string;
}

export async function testSsoProvider(id: string): Promise<TestConnectionResult> {
  return apiFetch<TestConnectionResult>(
    `/sso/providers/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}

export interface LinkUserToSsoResult {
  id: string;
  email: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
}

export async function linkUserToSso(
  userId: string,
  provider_id: string,
  subject: string,
): Promise<LinkUserToSsoResult> {
  return apiFetch<LinkUserToSsoResult>(`/users/${userId}/link-sso`, {
    method: "POST",
    body: { provider_id, subject },
  });
}

export async function unlinkUserSso(userId: string): Promise<void> {
  await apiFetch(`/users/${userId}/sso-link`, { method: "DELETE" });
}
