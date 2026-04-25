# Frontend state management

This page documents how state is organized in the **fleet-ui** SPA and
when to reach for which tool. The short version: **most state stays
local**; we use [Zustand](https://github.com/pmndrs/zustand) only for
state that genuinely needs to be global.

> **Why not Redux / TanStack Query / Recoil?**
> The app has one user, ~6 list endpoints, no real-time data, and
> short-lived forms. Redux's reducer/dispatch ceremony is overkill;
> TanStack Query would be a great fit if we add many more endpoints
> or background polling, but isn't justified yet. Zustand gives us a
> tiny global-state primitive (~1KB) for the few cases that need it
> without locking us into a framework.

## Decision tree

```
Is this state owned by a single component?
├── Yes  → useState (or useReducer if many fields move together)
└── No   → Does it need to survive component unmount?
          ├── No   → lift to common parent + props
          └── Yes  → Zustand store
```

| State                                    | Where it lives                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| Form fields (name, content, validation)  | `useReducer` inside the component (e.g. `PipelineForm`) |
| Toggles, modals, search input            | `useState`                                              |
| Admin bearer token + sign-in status      | `useAuthStore` (Zustand)                                |
| Toast / notification queue               | `useToastStore` (Zustand)                               |
| Cached list responses (pipelines, etc.)  | `useCacheStore` + `useCachedList` (Zustand)             |
| Per-page fetch results                   | `useAsync` / `useCachedList`                            |

## Why `PipelineForm` uses `useReducer`, not Zustand

The form has 7 pieces of related state (`name`, `selector`, `enabled`,
`content`, `error`, `validation`, `validating`). Putting them in a
Zustand store would create three real bugs:

1. **Stale state across navigations.** A global store outlives the
   component, so the next visit to `/pipelines/new` would show the
   previous draft.
2. **Two `PipelineForm` instances would share state.** Side-by-side
   edit forms would stomp on each other.
3. **Validation results are time-bound** to the current draft content.
   Storing them globally invites them to outlive the content they
   describe.

`useReducer` keeps all the locality benefits of `useState` while making
multi-field transitions atomic and explicit. See
`apps/fleet-ui/src/components/PipelineForm.tsx` for the pattern.

## The stores

All stores live under `apps/fleet-ui/src/store/`. Components subscribe
with the hook (e.g. `useAuthStore(selector)`); non-React code uses the
imperative helpers exported alongside.

### `useAuthStore` — `store/auth.ts`

Source of truth for the admin bearer token and the gate's status.

```ts
import { useAuthStore } from "@/store/auth";

const token = useAuthStore((s) => s.token);
const signOut = useAuthStore((s) => s.signOut);
```

The legacy `getAdminToken` / `setAdminToken` exports in
`api/client.ts` now delegate to this store, so existing callers
(notably `apiFetch`) keep working without changes. New code should
prefer the hook for reactive access.

`signOut()` also calls `useCacheStore.clear()` so a different admin
signing in next doesn't see stale lists from the previous session.

### `useToastStore` — `store/toasts.ts`

Global notifications. Mount `<Toaster />` once at the app root
(already done in `App.tsx`).

```ts
import { toast } from "@/store/toasts";

toast.success("Saved", "Pipeline v3 hash a1b2c3d4.");
toast.error("Save failed", "HTTP 422: invalid Alloy syntax");
toast.info("Background sync running");
toast.warn("Connection unstable");
```

| Tone     | Default TTL | Use for                                      |
| -------- | ----------- | -------------------------------------------- |
| success  | 4s          | Successful mutations the user already saw    |
| info     | 4s          | Background events the user might miss        |
| warn     | 6s          | Non-fatal issues (degraded perf, retry, etc.)|
| error    | sticky      | Failures the user must acknowledge           |

Toasts are **additive** to the existing inline error banners, not a
replacement. Inline banners stay for in-context detail (a 3-line
validation error next to the textarea); toasts surface cross-page
events (a save that already navigated the user away).

### `useCacheStore` + `useCachedList` — `store/cache.ts`, `components/CachedAsync.tsx`

Memory cache for list endpoints, keyed by string. Returns the cached
value instantly while a fresh fetch happens in the background
(stale-while-revalidate).

```ts
import { useCachedList } from "@/components/CachedAsync";
import { listPipelines } from "@/api/pipelines";

export const PIPELINES_CACHE_KEY = "pipelines.list";

const state = useCachedList(PIPELINES_CACHE_KEY, listPipelines);
```

After a mutation, drop the cache so the next read pulls fresh data:

```ts
import { invalidateCache } from "@/store/cache";

await updatePipeline(id, patch);
invalidateCache(PIPELINES_CACHE_KEY);
```

The cache lives in memory only — refreshing the page clears it. That
is intentional: localStorage caching invites stale-data bugs that take
hours to debug for very little UX win on a self-hosted internal tool.

## When to add a new store

Add one when **all** of the following are true:

- The state is read or written by ≥ 2 components in different parts of
  the tree, **and**
- Lifting it to a common parent would mean prop-drilling through ≥ 2
  layers, **or** the state must survive when the components unmount.

If only one of those is true, prefer:

- `useState` / `useReducer` (single component)
- React Context (a few components, no need for fine-grained
  subscriptions)
- An exported function on a service module (imperative actions
  without state)

## Files

- `apps/fleet-ui/src/store/auth.ts` — auth store
- `apps/fleet-ui/src/store/toasts.ts` — toast store
- `apps/fleet-ui/src/store/cache.ts` — list-cache store
- `apps/fleet-ui/src/components/Toaster.tsx` — toast viewport
- `apps/fleet-ui/src/components/CachedAsync.tsx` — `useCachedList` hook
