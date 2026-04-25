/**
 * Structured error thrown for non-2xx responses. Callers that want to
 * branch on status (e.g. retry on 409 pipeline_name_taken) get a typed
 * object with `status` and the parsed JSON body when available.
 */
export class FleetApiError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "FleetApiError";
    this.status = status;
    this.body = body;
  }
}
