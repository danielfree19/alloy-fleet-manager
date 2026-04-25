import { FleetApiError } from "./errors.js";
import type {
  AssembledConfig,
  AuditEvent,
  CatalogListResponse,
  CatalogTemplate,
  CreatePipelineInput,
  Labels,
  ListAuditFilter,
  Pipeline,
  PipelineDetail,
  RemotecfgCollector,
  UpdatePipelineInput,
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
