import { NavLink, Outlet } from "react-router-dom";
import { setAdminToken } from "@/api/client";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/collectors", label: "Collectors" },
  { to: "/pipelines", label: "Pipelines" },
  { to: "/catalog", label: "Catalog" },
  { to: "/audit", label: "Audit log" },
];

export function Layout() {
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
        <nav className="flex-1 p-3 space-y-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm transition ${
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "text-text/80 hover:bg-border/50 hover:text-text"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border">
          <button
            className="btn w-full justify-center"
            onClick={() => {
              setAdminToken(null);
              location.reload();
            }}
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
