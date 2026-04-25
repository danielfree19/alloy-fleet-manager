import { Navigate, useLocation } from "react-router-dom";
import type { PropsWithChildren } from "react";
import { useAuthStore } from "@/store/auth";

/**
 * Route guard for protected pages.
 *
 * Wraps the authenticated layout (`<Layout />`). When the auth store
 * reports `locked` we navigate to `/login` and stash the would-be
 * destination in `?next=<path>` so the login page can bounce the user
 * back after they sign in.
 *
 * `checking` shows the same spinner the AuthProbe used so a
 * mid-session re-check (e.g. after a 401 → re-probe) doesn't flash
 * the login screen for one frame.
 *
 * `unlocked` is the happy path — render whatever's nested inside.
 */
export function RequireAuth({ children }: PropsWithChildren) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        Checking credentials…
      </div>
    );
  }

  if (status === "locked") {
    // Preserve the path AND query so a deep link like
    // /pipelines?selector=role:edge survives the round-trip.
    const next = location.pathname + location.search + location.hash;
    const search = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
    return <Navigate to={`/login${search}`} replace />;
  }

  return <>{children}</>;
}
