import { request } from "undici";
import type {
  DesiredConfigResponse,
  RegisterResponse,
  RegisterRequest,
  HeartbeatRequest,
  RolloutEventRequest,
} from "@fleet/shared";

export class FleetApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "FleetApiError";
  }
}

export interface FleetApiOpts {
  baseUrl: string;
  timeoutMs?: number;
}

export class FleetApi {
  constructor(private readonly opts: FleetApiOpts) {}

  private async doRequest<T>(
    method: "GET" | "POST",
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const url = this.opts.baseUrl + path;
    const res = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      bodyTimeout: this.opts.timeoutMs ?? 10_000,
      headersTimeout: this.opts.timeoutMs ?? 10_000,
    });
    const text = await res.body.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (res.statusCode >= 400) {
      throw new FleetApiError(
        `fleet-manager ${method} ${path} -> ${res.statusCode}`,
        res.statusCode,
        parsed,
      );
    }
    return { status: res.statusCode, body: parsed as T };
  }

  // NOTE on path prefixes: the Fleet Manager exposes two surfaces side by side.
  // The primary (Alloy-native remotecfg) surface lives at the root. This
  // legacy Node.js agent talks to the REST surface at /legacy/* so the two
  // don't collide.
  async register(registrationToken: string, req: RegisterRequest): Promise<RegisterResponse> {
    const r = await this.doRequest<RegisterResponse>(
      "POST",
      "/legacy/collectors/register",
      registrationToken,
      req,
    );
    return r.body;
  }

  async getDesiredConfig(
    collectorId: string,
    apiKey: string,
  ): Promise<DesiredConfigResponse | null> {
    try {
      const r = await this.doRequest<DesiredConfigResponse>(
        "GET",
        `/legacy/agent/configs/${collectorId}`,
        apiKey,
      );
      return r.body;
    } catch (err) {
      if (err instanceof FleetApiError && err.status === 404) return null;
      throw err;
    }
  }

  async heartbeat(collectorId: string, apiKey: string, req: HeartbeatRequest): Promise<void> {
    await this.doRequest("POST", `/legacy/heartbeats/${collectorId}`, apiKey, req);
  }

  async rolloutEvent(
    collectorId: string,
    apiKey: string,
    req: RolloutEventRequest,
  ): Promise<void> {
    await this.doRequest("POST", `/legacy/rollout_events/${collectorId}`, apiKey, req);
  }
}
