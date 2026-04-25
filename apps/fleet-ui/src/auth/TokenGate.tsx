import { useEffect, useState, type PropsWithChildren } from "react";
import { ApiError, apiFetch, getAdminToken, setAdminToken } from "@/api/client";

type Status = "checking" | "locked" | "unlocked";

/**
 * Gate the whole app behind a valid admin token. We probe `/pipelines` with
 * whatever is in localStorage at mount; if that 401s we show the login form,
 * otherwise we render the rest of the app. Having a single probe on mount
 * means per-page components can assume calls are authenticated.
 */
export function TokenGate({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<Status>("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void probe();
  }, []);

  async function probe() {
    const token = getAdminToken();
    if (!token) {
      setStatus("locked");
      return;
    }
    setStatus("checking");
    try {
      await apiFetch("/pipelines");
      setStatus("unlocked");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setAdminToken(null);
        setStatus("locked");
      } else {
        // Network / server error — let the app through and let individual
        // pages surface the error.
        setStatus("unlocked");
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdminToken(input.trim() || null);
    try {
      await apiFetch("/pipelines");
      setStatus("unlocked");
    } catch (err) {
      setAdminToken(null);
      if (err instanceof ApiError) {
        setError(
          err.status === 401 || err.status === 403
            ? "Invalid admin token."
            : `Error: ${err.message}`,
        );
      } else {
        setError("Couldn't reach the fleet manager.");
      }
    }
  }

  if (status === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Checking credentials…
      </div>
    );
  }

  if (status === "locked") {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <form
          onSubmit={submit}
          className="card w-full max-w-sm p-6 space-y-4"
          autoComplete="off"
        >
          <div>
            <h1 className="text-lg font-semibold">Fleet Manager</h1>
            <p className="text-sm text-muted mt-1">
              Enter your admin bearer token to continue.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted" htmlFor="token">
              Admin token
            </label>
            <input
              id="token"
              type="password"
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="change-me-admin-token"
              autoFocus
            />
            <p className="text-[11px] text-muted/80">
              Stored locally in your browser. Use the value of{" "}
              <code className="mono">ADMIN_TOKEN</code> on the manager.
            </p>
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
          <button type="submit" className="btn btn-primary w-full justify-center">
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
