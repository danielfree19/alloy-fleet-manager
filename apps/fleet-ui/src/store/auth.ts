/**
 * Auth store.
 *
 * Three sign-in modes — all converge on the same shape:
 *
 *  1. Email + password   →  POST /auth/login → session cookie
 *  2. Cookie session     →  no UI step, the browser sends `fleet.sid`
 *                            on every request. We probe /auth/me at
 *                            mount to learn the current actor.
 *  3. Bearer token paste →  legacy break-glass with ADMIN_TOKEN, or
 *                            programmatic API tokens for power users.
 *                            Stored in localStorage and added as
 *                            Authorization header by `apiFetch`.
 *
 * The store is the single source of truth for the resolved actor:
 * email, name, kind, and the materialized permission set the UI uses
 * to gate menu items and buttons. Components subscribe via
 * `useAuthStore(...)`. Code outside React (apiFetch, retry logic) uses
 * the imperative `getTokenSnapshot` helper.
 */
import { create } from "zustand";
import { useCacheStore } from "@/store/cache";

const TOKEN_KEY = "fleet.adminToken";

export type AuthStatus = "checking" | "locked" | "unlocked";

export type ActorKind = "env_token" | "user" | "api_token";

/**
 * Permission strings — kept in sync with auth/permissions.ts in the
 * manager. We don't import them across packages because the UI is a
 * separate workspace; instead we type the field as `string` and
 * provide a helper hook that hides the casting.
 */
export type Permission =
  | "pipelines.read"
  | "pipelines.create"
  | "pipelines.update"
  | "pipelines.delete"
  | "collectors.read"
  | "collectors.poll"
  | "catalog.read"
  | "audit.read"
  | "users.read"
  | "users.write"
  | "tokens.read"
  | "tokens.write"
  | "sso.read"
  | "sso.write";

export interface ResolvedActor {
  kind: ActorKind;
  user_id: string | null;
  email: string | null;
  name: string | null;
  api_token_id: string | null;
  /**
   * Populated for SSO-managed users so the UI can render the
   * "SSO · <provider>" badge and disable the local-password
   * change form on My Account. `null` for local-password users
   * and for env-token / api_token actors.
   */
  oidc_issuer: string | null;
  oidc_subject: string | null;
}

interface AuthState {
  /** Bearer token. `null` means we rely on cookies (or are signed out). */
  token: string | null;
  /** Gate status — drives whether the app or the login form renders. */
  status: AuthStatus;
  /** Resolved current actor, populated from /auth/me after sign-in. */
  actor: ResolvedActor | null;
  /** Materialized permission set; checked in UI to gate menu items. */
  permissions: Set<Permission>;

  setToken: (token: string | null) => void;
  setSession: (actor: ResolvedActor, permissions: Permission[]) => void;
  signOut: () => void;
  setStatus: (status: AuthStatus) => void;
}

function readInitialToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export const useAuthStore = create<AuthState>((set) => ({
  token: readInitialToken(),
  // Always start in "checking" so the very first paint shows a
  // spinner rather than briefly flashing the login form. Even with
  // no bearer token the cookie probe on mount might unlock us.
  status: "checking",
  actor: null,
  permissions: new Set<Permission>(),

  setToken: (token) => {
    if (typeof localStorage !== "undefined") {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    }
    set({ token });
  },

  setSession: (actor, permissions) =>
    set({
      actor,
      permissions: new Set(permissions),
      status: "unlocked",
    }),

  signOut: () => {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(TOKEN_KEY);
    }
    // Drop every cached list — a different user signing in next
    // shouldn't see the previous user's last-known data flash on
    // screen before the fresh fetch resolves.
    useCacheStore.getState().clear();
    set({
      token: null,
      actor: null,
      permissions: new Set<Permission>(),
      status: "locked",
    });
  },

  setStatus: (status) => set({ status }),
}));

export function getTokenSnapshot(): string | null {
  return useAuthStore.getState().token;
}

export function setTokenImperative(token: string | null): void {
  useAuthStore.getState().setToken(token);
}

/**
 * Convenience hook: does the current actor hold every listed permission?
 *
 *   const canEdit = useHasPermission("pipelines.update");
 *
 * Returns true for the env-token actor (it always has all permissions
 * server-side, but the /auth/me response materializes them so the
 * lookup is uniform).
 */
export function useHasPermission(...required: Permission[]): boolean {
  return useAuthStore((s) => required.every((p) => s.permissions.has(p)));
}
