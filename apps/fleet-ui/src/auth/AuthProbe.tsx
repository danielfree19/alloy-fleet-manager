import { useEffect, type PropsWithChildren } from "react";
import { ApiError, apiFetch } from "@/api/client";
import { useAuthStore, type Permission, type ResolvedActor } from "@/store/auth";

/**
 * One-shot identity probe.
 *
 * Mounts once at app startup and asks the manager who we are via
 * `GET /auth/me`. Whatever it learns lands in `useAuthStore`:
 *   - 200            → status="unlocked", actor + permissions populated
 *   - 401 / 403      → status="locked"
 *   - network error  → status="unlocked" (don't hold the user hostage on
 *                       a hiccup; downstream pages surface their own errors)
 *
 * Crucially this component does NOT render a login form. Routing
 * decisions live in `RequireAuth` and `pages/Login`. We just render
 * children and a brief spinner while the very first probe is in flight.
 *
 * Subsequent locks (session expiry mid-flight, manual logout) are
 * driven by `apiFetch` flipping the store to "locked" on 401, which
 * triggers `RequireAuth` to redirect.
 */
interface MeResponse {
  actor: ResolvedActor;
  permissions: Permission[];
}

export function AuthProbe({ children }: PropsWithChildren) {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    // Read setters off the store imperatively rather than via
    // selectors so the effect has a genuinely empty deps array —
    // Zustand setters are stable but biome's hook-deps lint doesn't
    // know that.
    const { setStatus, setSession, setToken } = useAuthStore.getState();
    let cancelled = false;
    (async () => {
      try {
        const me = await apiFetch<MeResponse>("/auth/me");
        if (!cancelled) setSession(me.actor, me.permissions);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          // Cookie missing/expired or stale bearer; stay locked. We
          // clear the bearer so the next call doesn't keep failing
          // with the same bad token.
          setToken(null);
          setStatus("locked");
        } else {
          setStatus("unlocked");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Checking credentials…
      </div>
    );
  }

  return <>{children}</>;
}
