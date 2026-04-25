import { FleetApiError } from "./errors.js";
import type {
  ApiTokenSummary,
  AssembledConfig,
  AuditEvent,
  CatalogListResponse,
  CatalogTemplate,
  CreateApiTokenInput,
  CreateApiTokenResponse,
  CreatePipelineInput,
  CreateRoleInput,
  CreateUserInput,
  Labels,
  ListAuditFilter,
  MeResponse,
  Pipeline,
  PipelineDetail,
  RemotecfgCollector,
  Role,
  UpdatePipelineInput,
  UpdateRoleInput,
  UpdateUserInput,
  User,
  ValidateResult,
} from "./types.js";

/**
 * `FleetClient` — thin, typed wrapper over the Fleet Manager admin API.
 *
 * Uses the global `fetch` so it runs unmodified in Node.js (>=18),
 * modern browsers, Bun, and Deno. No polyfill, no extra deps.
 *
 * Errors are normalized: any non-2xx response is thrown as
 * `FleetApiError` with the parsed body + HTTP status attached.
 */
export interface FleetClientOptions {
  /** Base URL of the Fleet Manager, e.g. `http://localhost:9090`. No trailing slash required. */
  endpoint: string;
  /** Bearer token for admin routes (the manager's `ADMIN_TOKEN`). */
  adminToken: string;
  /**
   * Fetch override — useful for tests (inject `fetch-mock`) or for
   * environments that pre-wrap fetch with tracing / retries. Defaults to
   * the platform's global `fetch`.
   */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. Use for tracing ids etc. */
  defaultHeaders?: Record<string, string>;
}

export class FleetClient {
  private readonly endpoint: string;
  private readonly adminToken: string;
  private readonly _fetch: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: FleetClientOptions) {
    if (!opts.endpoint) throw new Error("FleetClient: endpoint is required");
    if (!opts.adminToken) throw new Error("FleetClient: adminToken is required");
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.adminToken = opts.adminToken;
    this._fetch = opts.fetch ?? globalThis.fetch;
    if (!this._fetch) {
      throw new Error(
        "FleetClient: no `fetch` available. Upgrade to Node.js 18+ or pass a `fetch` option.",
      );
    }
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  // ---- Pipelines ---------------------------------------------------------

  async listPipelines(): Promise<Pipeline[]> {
    const r = await this.request<{ pipelines: Pipeline[] }>("GET", "/pipelines");
    return r.pipelines;
  }

  async getPipeline(id: string): Promise<PipelineDetail> {
    return this.request<PipelineDetail>("GET", `/pipelines/${encodeURIComponent(id)}`);
  }

  /** Resolve a pipeline by human-readable name. Implemented client-side via list+filter. */
  async getPipelineByName(name: string): Promise<PipelineDetail | null> {
    const all = await this.listPipelines();
    const match = all.find((p) => p.name === name);
    if (!match) return null;
    return this.getPipeline(match.id);
  }

  async createPipeline(input: CreatePipelineInput): Promise<Pipeline> {
    return this.request<Pipeline>("POST", "/pipelines", input);
  }

  async updatePipeline(id: string, input: UpdatePipelineInput): Promise<Pipeline> {
    return this.request<Pipeline>("PATCH", `/pipelines/${encodeURIComponent(id)}`, input);
  }

  async deletePipeline(id: string): Promise<void> {
    await this.request<void>("DELETE", `/pipelines/${encodeURIComponent(id)}`);
  }

  async validatePipelineContent(content: string): Promise<ValidateResult> {
    return this.request<ValidateResult>("POST", "/pipelines/validate", { content });
  }

  /** Preview the assembled config for a hypothetical collector with these attrs. */
  async assembleForAttributes(attributes: Labels): Promise<AssembledConfig> {
    return this.request<AssembledConfig>("POST", "/pipelines/assemble", { attributes });
  }

  // ---- Collectors --------------------------------------------------------

  async listCollectors(): Promise<RemotecfgCollector[]> {
    const r = await this.request<{ collectors: RemotecfgCollector[] }>(
      "GET",
      "/remotecfg/collectors",
    );
    return r.collectors;
  }

  // ---- Catalog -----------------------------------------------------------

  /**
   * List available pipeline templates. Lightweight — each entry omits
   * the Alloy `content` field. Call `getCatalogTemplate(id)` to fetch
   * the full template including content.
   */
  async listCatalog(): Promise<CatalogListResponse> {
    return this.request<CatalogListResponse>("GET", "/catalog");
  }

  /** Fetch a single template, including its Alloy `content`. */
  async getCatalogTemplate(id: string): Promise<CatalogTemplate> {
    const r = await this.request<{ template: CatalogTemplate }>(
      "GET",
      `/catalog/${encodeURIComponent(id)}`,
    );
    return r.template;
  }

  /**
   * Convenience: install a template as a new pipeline. This is
   * equivalent to `getCatalogTemplate` + `createPipeline`, but keeps
   * the CLI / scripting common case in one call. Overrides merge on
   * top of the template's defaults: `name` defaults to
   * `suggested_name || id`, `selector` to `default_selector`.
   */
  async installCatalogTemplate(
    id: string,
    overrides: {
      name?: string;
      selector?: Labels;
      enabled?: boolean;
      content?: string;
    } = {},
  ): Promise<Pipeline> {
    const t = await this.getCatalogTemplate(id);
    return this.createPipeline({
      name: overrides.name ?? t.suggested_name ?? t.id,
      selector: overrides.selector ?? t.default_selector,
      enabled: overrides.enabled ?? true,
      content: overrides.content ?? t.content,
    });
  }

  // ---- Identity ----------------------------------------------------------
  //
  // Resolves whatever bearer the client is configured with. For an env
  // `ADMIN_TOKEN`, `kind === "env_token"` and `userId === null`; for an
  // `fmt_…` API token, `kind === "api_token"` and `userId` is the owner.
  // Useful for "do I need to provide user_id when minting a token?".

  async me(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/auth/me");
  }

  // ---- Roles -------------------------------------------------------------

  async listRoles(): Promise<Role[]> {
    const r = await this.request<{ roles: Role[] }>("GET", "/roles");
    return r.roles;
  }

  /** Convenience: find a built-in or custom role by exact name. */
  async findRole(name: string): Promise<Role | null> {
    const all = await this.listRoles();
    return all.find((r) => r.name === name) ?? null;
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    return this.request<Role>("POST", "/roles", input);
  }

  async updateRole(id: string, input: UpdateRoleInput): Promise<Role> {
    return this.request<Role>("PATCH", `/roles/${encodeURIComponent(id)}`, input);
  }

  async deleteRole(id: string): Promise<void> {
    await this.request<void>("DELETE", `/roles/${encodeURIComponent(id)}`);
  }

  // ---- Users -------------------------------------------------------------

  async listUsers(): Promise<User[]> {
    const r = await this.request<{ users: User[] }>("GET", "/users");
    return r.users;
  }

  async getUser(id: string): Promise<User> {
    return this.request<User>("GET", `/users/${encodeURIComponent(id)}`);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const all = await this.listUsers();
    return all.find((u) => u.email === email) ?? null;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    return this.request<User>("POST", "/users", input);
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<User> {
    return this.request<User>("PATCH", `/users/${encodeURIComponent(id)}`, input);
  }

  async deleteUser(id: string): Promise<void> {
    await this.request<void>("DELETE", `/users/${encodeURIComponent(id)}`);
  }

  // ---- API tokens --------------------------------------------------------
  //
  // Tokens carry a *subset* of their owner's roles (privilege containment is
  // enforced server-side). Plaintext is returned exactly once, by
  // `createApiToken` / `createAgentToken` — store it immediately.

  async listApiTokens(opts: { user_id?: string } = {}): Promise<ApiTokenSummary[]> {
    const path = opts.user_id
      ? `/users/${encodeURIComponent(opts.user_id)}/tokens`
      : "/tokens";
    const r = await this.request<{ tokens: ApiTokenSummary[] }>("GET", path);
    return r.tokens;
  }

  async getApiToken(id: string): Promise<ApiTokenSummary> {
    return this.request<ApiTokenSummary>("GET", `/tokens/${encodeURIComponent(id)}`);
  }

  async createApiToken(input: CreateApiTokenInput): Promise<CreateApiTokenResponse> {
    return this.request<CreateApiTokenResponse>("POST", "/tokens", input);
  }

  async revokeApiToken(id: string): Promise<void> {
    await this.request<void>("DELETE", `/tokens/${encodeURIComponent(id)}`);
  }

  /**
   * Mint a token for an Alloy collector. Looks up the built-in `agent`
   * role (single permission: `collectors.poll`) and creates a token bound
   * to it. Useful for per-host token issuance from automation:
   *
   * ```ts
   * const t = await sdk.createAgentToken({
   *   name: "edge-host-01",
   *   user_id: serviceAccountId,
   * });
   * // Drop t.token into the host's bootstrap.alloy then forget it.
   * ```
   *
   * If the manager doesn't expose an `agent` role (very old deployments
   * pre-`collectors.poll`), this throws with a message pointing at the
   * fallback: use the legacy `AGENT_BEARER_TOKEN` env var on the manager
   * instead.
   */
  async createAgentToken(input: {
    name: string;
    user_id?: string;
    expires_at?: string | null;
  }): Promise<CreateApiTokenResponse> {
    const role = await this.findRole("agent");
    if (!role) {
      throw new Error(
        "FleetClient.createAgentToken: no `agent` role on the manager. " +
          "Upgrade the manager (it ships built-in) or use AGENT_BEARER_TOKEN.",
      );
    }
    return this.createApiToken({
      name: input.name,
      user_id: input.user_id,
      role_ids: [role.id],
      expires_at: input.expires_at ?? null,
    });
  }

  // ---- Audit -------------------------------------------------------------

  async listAuditEvents(filter: ListAuditFilter = {}): Promise<AuditEvent[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    const path = `/audit${qs.size ? "?" + qs.toString() : ""}`;
    const r = await this.request<{ events: AuditEvent[]; limit: number }>("GET", path);
    return r.events;
  }

  // ---- Low-level ---------------------------------------------------------

  /**
   * Raw request helper. Most callers won't need this; exposed for forward
   * compatibility with endpoints added to the manager after this SDK
   * version was published.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.endpoint}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      authorization: `Bearer ${this.adminToken}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this._fetch(url, init);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new FleetApiError(res.status, message, parsed);
    }
    return parsed as T;
  }
}
