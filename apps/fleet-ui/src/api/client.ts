/**
 * Thin fetch wrapper that attaches the admin bearer token from the
 * auth store (which mirrors localStorage) and normalizes errors into a
 * single `ApiError` shape. All page-level hooks should go through here
 * so auth + error handling live in exactly one place.
 *
 * `getAdminToken` / `setAdminToken` are kept as exports for backward
 * compatibility — the auth store is now the source of truth, but a
 * lot of existing code (Layout, apiFetch itself, AuthProbe) was
 * written against this functional API. New code should prefer
 * `useAuthStore` for reactive access.
 *
 * 401 handling: if the manager rejects a request as unauthenticated
 * AFTER we already had a session, we flip the auth store to "locked"
 * and let `RequireAuth` redirect to /login. We intentionally skip
 * the auth endpoints themselves: a 401 from /auth/login is "wrong
 * password" — surfacing that as a forced redirect would be jarring.
 */
import { useAuthStore, getTokenSnapshot, setTokenImperative } from "@/store/auth";

export function getAdminToken(): string | null {
  return getTokenSnapshot();
}

export function setAdminToken(token: string | null): void {
  setTokenImperative(token);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    // Always include the session cookie. In dev (vite at :5173 hitting
    // the manager at :9090) this requires the manager's CORS to set
    // `credentials: true` and to echo a specific origin (no `*`),
    // which it does. In production the UI is same-origin so the flag
    // is a no-op.
    credentials: "include",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload: unknown = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message =
      (isJson && payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    if (res.status === 401 && !isAuthEndpoint(path)) {
      // Session expired or bearer token revoked while we were
      // already inside the app. Flip the store to "locked" so
      // RequireAuth redirects to /login on the next render. We
      // also clear the bearer in case it was the source of the 401.
      const { setStatus, setToken: clearToken } = useAuthStore.getState();
      clearToken(null);
      setStatus("locked");
    }
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

/**
 * Auth-shaped paths whose 401 we should NOT treat as "session
 * expired". These are called explicitly by the login flow itself.
 */
function isAuthEndpoint(path: string): boolean {
  return path === "/auth/login" || path === "/auth/me";
}
