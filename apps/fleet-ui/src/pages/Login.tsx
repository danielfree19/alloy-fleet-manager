import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "@/api/client";
import { listAuthProviders, type AuthProviderEntry } from "@/api/identity";
import { useAuthStore, type Permission, type ResolvedActor } from "@/store/auth";

/**
 * `/login` route. Two sign-in modes:
 *
 *   1. Email + password — primary. Calls POST /auth/login (which sets
 *      the `fleet.sid` cookie), then re-probes /auth/me to get the
 *      resolved actor + permissions.
 *   2. Bearer token paste — fallback for break-glass (`ADMIN_TOKEN`)
 *      or programmatic API tokens. Stored in localStorage; apiFetch
 *      attaches it on every subsequent request.
 *
 * After a successful sign-in we honor the `?next=<path>` query param
 * so deep links survive the round-trip. If `?next` is missing or
 * points outside the app, we fall back to "/".
 *
 * If the user is already signed in we redirect away — visiting
 * /login while authenticated should not show the form.
 */
interface MeResponse {
  actor: ResolvedActor;
  permissions: Permission[];
}

export function Login() {
  const status = useAuthStore((s) => s.status);
  const setSession = useAuthStore((s) => s.setSession);
  const setToken = useAuthStore((s) => s.setToken);
  const signOut = useAuthStore((s) => s.signOut);

  const navigate = useNavigate();
  const location = useLocation();

  const next = readNextParam(location.search);

  const [mode, setMode] = useState<"password" | "token">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<AuthProviderEntry[]>([]);
  // Surface the rejection reason that the SSO callback redirected back
  // with so users immediately see why their attempt failed instead of a
  // silent return to the form. The `?sso_error=...` query is set by the
  // sso callback route (or by the static rejection page's "back to
  // login" link). It's a stable enum identical to AuditAction metadata.
  const ssoError = readSsoErrorParam(location.search);

  // If we're already signed in (e.g. user typed /login by hand or
  // followed a stale link), bounce to `next` or `/`. Done in an
  // effect so we don't fight React Router's "rules of rendering".
  useEffect(() => {
    if (status === "unlocked") {
      navigate(next, { replace: true });
    }
  }, [status, next, navigate]);

  // Fetch the SSO provider list once. Returns [] when SSO is fully
  // disabled, so this is safe to call unconditionally — no spinner, no
  // gating: if it fails we just don't render any SSO buttons.
  useEffect(() => {
    let cancelled = false;
    listAuthProviders()
      .then((providers) => {
        if (!cancelled) setSsoProviders(providers);
      })
      .catch(() => {
        // Network error here is non-fatal — operators can still use
        // password / token flows. Logging would be noisy.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Avoid flashing the form for one frame while the AuthProbe is
  // still resolving the cookie on first paint.
  if (status === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Checking credentials…
      </div>
    );
  }
  if (status === "unlocked") {
    return <Navigate to={next} replace />;
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      const me = await apiFetch<MeResponse>("/auth/me");
      setSession(me.actor, me.permissions);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid email or password."
          : err instanceof ApiError
            ? `Error: ${err.message}`
            : "Couldn't reach the fleet manager.",
      );
      setBusy(false);
    }
  }

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = tokenInput.trim();
    if (!value) {
      setError("Paste a token to continue.");
      return;
    }
    setBusy(true);
    setToken(value);
    try {
      const me = await apiFetch<MeResponse>("/auth/me");
      setSession(me.actor, me.permissions);
      navigate(next, { replace: true });
    } catch (err) {
      // Bad token — clear it so we don't keep retrying the same
      // bearer on every page navigation.
      signOut();
      setError(
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? "Invalid token."
          : err instanceof ApiError
            ? `Error: ${err.message}`
            : "Couldn't reach the fleet manager.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="card w-full max-w-sm p-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Fleet Manager</h1>
          <p className="text-sm text-muted mt-1">
            {mode === "password"
              ? "Sign in with your account."
              : "Paste your admin token to continue."}
          </p>
        </div>

        {ssoError && (
          <div className="text-xs text-danger border border-danger/40 bg-danger/5 rounded px-3 py-2">
            Sign-in via SSO was rejected ({ssoError}). Contact an administrator
            if this looks wrong.
          </div>
        )}

        {ssoProviders.length > 0 && (
          <div className="space-y-2">
            {ssoProviders.map((p) => (
              <a
                key={p.id}
                // Full-page redirect on purpose — we need to leave the
                // SPA so cookies set by the IdP redirect callback are
                // visible to the manager on the next request.
                href={`/auth/sso/start/${encodeURIComponent(p.id)}?next=${encodeURIComponent(next)}`}
                className="btn btn-secondary w-full justify-center"
              >
                Sign in with {p.display_name}
              </a>
            ))}
            <div className="flex items-center gap-3 text-[11px] text-muted/70 uppercase tracking-wider">
              <div className="flex-1 border-t border-border" />
              <span>or</span>
              <div className="flex-1 border-t border-border" />
            </div>
          </div>
        )}

        {mode === "password" ? (
          <form onSubmit={submitPassword} className="space-y-3" autoComplete="on">
            <div className="space-y-1">
              <label className="text-xs text-muted" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            <button
              type="submit"
              className="btn btn-primary w-full justify-center"
              disabled={busy}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              className="text-xs text-muted hover:text-text underline w-full text-center"
              onClick={() => {
                setMode("token");
                setError(null);
              }}
            >
              Use an admin token instead
            </button>
          </form>
        ) : (
          <form onSubmit={submitToken} className="space-y-3" autoComplete="off">
            <div className="space-y-1">
              <label className="text-xs text-muted" htmlFor="token">
                Admin or API token
              </label>
              <input
                id="token"
                type="password"
                className="input"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="fmt_… or ADMIN_TOKEN"
                autoFocus
              />
              <p className="text-[11px] text-muted/80">
                Stored locally in your browser. Use a personal API token,
                or the value of <code className="mono">ADMIN_TOKEN</code> for
                break-glass access.
              </p>
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            <button
              type="submit"
              className="btn btn-primary w-full justify-center"
              disabled={busy}
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
            <button
              type="button"
              className="text-xs text-muted hover:text-text underline w-full text-center"
              onClick={() => {
                setMode("password");
                setError(null);
              }}
            >
              Use email and password instead
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Pull `?next=<path>` from the location search string and validate it.
 *
 * We only honor relative paths (must start with "/") to avoid open
 * redirect attacks where someone hands you a link like
 * `/login?next=https://evil.example.com/`.
 */
function readNextParam(search: string): string {
  const params = new URLSearchParams(search);
  const raw = params.get("next");
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // Don't redirect back to /login itself — would loop.
  if (raw === "/login" || raw.startsWith("/login?")) return "/";
  return raw;
}

/**
 * Pull `?sso_error=<reason>` from the location search string. Caller
 * is just rendering the value as a span, so we cap length and reject
 * anything that doesn't look like a stable enum identifier to avoid
 * surfacing junk if a third party crafts a malicious link.
 */
function readSsoErrorParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("sso_error");
  if (!raw) return null;
  if (raw.length > 64) return null;
  if (!/^[a-z0-9_]+$/i.test(raw)) return null;
  return raw;
}
