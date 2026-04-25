import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { apiFetch } from "@/api/client";
import {
  useAuthStore,
  useHasPermission,
  type Permission,
  type ResolvedActor,
} from "@/store/auth";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** If set, the link is hidden when the actor lacks every listed permission. */
  permission?: Permission;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", end: true },
  { to: "/collectors", label: "Collectors", permission: "collectors.read" },
  { to: "/pipelines", label: "Pipelines", permission: "pipelines.read" },
  { to: "/catalog", label: "Catalog", permission: "catalog.read" },
  { to: "/audit", label: "Audit log", permission: "audit.read" },
];

const SETTINGS_NAV: NavItem[] = [
  { to: "/settings/account", label: "My account" },
  { to: "/settings/tokens", label: "API tokens" },
  { to: "/settings/users", label: "Users", permission: "users.read" },
  { to: "/settings/roles", label: "Roles", permission: "users.read" },
  {
    to: "/settings/identity-providers",
    label: "Identity providers",
    permission: "sso.read",
  },
  { to: "/settings/sso-activity", label: "SSO activity", permission: "sso.read" },
];

export function Layout() {
  const signOut = useAuthStore((s) => s.signOut);
  const actor = useAuthStore((s) => s.actor);
  const navigate = useNavigate();

  async function onSignOut() {
    // Best-effort POST /auth/logout so the cookie session row in PG
    // is cleared. A failure here (manager down, network blip) still
    // proceeds with the local sign-out so the user isn't stuck.
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // ignored — the local store is the source of truth for UI state
    }
    // Navigate to /login BEFORE flipping the store so RequireAuth
    // doesn't grab the current path as `?next` — an intentional
    // logout shouldn't return the user to the page they just left.
    navigate("/login", { replace: true });
    signOut();
  }

  return (
    <div className="h-full flex">
      <aside className="w-60 shrink-0 border-r border-border bg-surface/60 flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <LogoMark />
            <div>
              <div className="text-sm font-semibold leading-tight">Fleet</div>
              <div className="text-[11px] text-muted leading-tight">Manager</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map((n) => (
            <NavRow key={n.to} item={n} />
          ))}
          <div className="pt-3 mt-3 border-t border-border">
            <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted/70">
              Settings
            </div>
            {SETTINGS_NAV.map((n) => (
              <NavRow key={n.to} item={n} />
            ))}
          </div>
        </nav>
        <div className="p-3 border-t border-border space-y-2">
          {actor && <ActorBadge actor={actor} />}
          <button
            type="button"
            className="btn w-full justify-center"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavRow({ item }: { item: NavItem }) {
  // `useHasPermission()` with no args returns true; that's the
  // "always show this link" path for items with no permission gate.
  const allowed = useHasPermission(...(item.permission ? [item.permission] : []));
  if (item.permission && !allowed) return null;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `block rounded-md px-3 py-2 text-sm transition ${
          isActive
            ? "bg-accent-soft text-accent"
            : "text-text/80 hover:bg-border/50 hover:text-text"
        }`
      }
    >
      {item.label}
    </NavLink>
  );
}

function ActorBadge({ actor }: { actor: ResolvedActor }) {
  // Shows "alice@x.com" for users, "(API token)" / "(env token)" for
  // programmatic actors. The kind label helps operators realize when
  // they're using a break-glass credential.
  const label =
    actor.kind === "user"
      ? actor.email ?? actor.name ?? actor.user_id ?? "(unknown user)"
      : actor.kind === "api_token"
        ? "(API token)"
        : "(env token)";
  return (
    <div className="px-3 py-1.5 rounded-md bg-border/30 text-[11px] text-muted overflow-hidden">
      <div className="text-muted/70 mb-0.5">Signed in as</div>
      <div className="truncate text-text/90 font-medium">{label}</div>
    </div>
  );
}

function LogoMark() {
  return (
    <div className="h-8 w-8 rounded-md bg-accent-soft border border-accent/40 flex items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 text-accent"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M3 9l9-5 9 5-9 5-9-5z" />
        <path d="M3 15l9 5 9-5" />
        <path d="M3 12l9 5 9-5" />
      </svg>
    </div>
  );
}
