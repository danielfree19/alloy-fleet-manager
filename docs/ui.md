# Admin UI (`apps/fleet-ui`)

A React + Vite single-page app that wraps the Fleet Manager's admin REST
endpoints. It lets operators:

- See every registered Alloy collector and its last-reported status.
- Create, edit, enable/disable, and delete **pipelines**.
- Browse every pipeline's immutable version history.
- Preview the exact Alloy config the manager would serve to a hypothetical
  collector with arbitrary attributes — **no real collector required**.

The UI is strictly a client of the admin API. It doesn't hold any state the
API doesn't; refreshing the page always reflects the server.

## Architecture

```
browser ──► /ui/**        (static, @fastify/static)
       └──► /pipelines    (admin JSON)
       └──► /pipelines/assemble (admin JSON — preview)
       └──► /remotecfg/collectors (admin JSON)
```

- **Stack**: React 18, TypeScript, Vite 5, React Router 6, Tailwind 3.
- **Auth**: a single bearer token (`ADMIN_TOKEN`) stored in `localStorage`
  under the key `fleet.adminToken`. Attached as `Authorization: Bearer …` on
  every request by `src/api/client.ts`. The `TokenGate` component probes
  `GET /pipelines` at mount; if the API returns 401/403 it shows the login
  screen.
- **State management**: most state stays in `useState` / `useReducer`
  inside the component that owns it. Three small Zustand stores cover
  the genuinely global cases: `useAuthStore` (token + sign-in status),
  `useToastStore` (notifications), and `useCacheStore` (in-memory list
  cache for snappy navigation). See [`docs/state.md`](./state.md) for
  the decision tree and per-store API.
- **Routing**: served under `/ui/` in production (see `vite.config.ts`
  `base: "/ui/"` and `main.tsx` `basename`). The fleet-manager has a
  catch-all SPA fallback so deep links like `/ui/pipelines/<uuid>` work.
- **Styling**: Tailwind with a single dark palette defined as CSS variables
  on `:root` in `src/index.css`. Tweak those variables to re-theme the whole
  app in one place.

## Pages

| Route                  | What it does                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `/`                    | Overview: counts + recent activity lists.                                                         |
| `/collectors`          | Table of every registered Alloy instance (via `GET /remotecfg/collectors`).                       |
| `/collectors/:id`      | Collector detail + **Assembled Config Preview** that calls `POST /pipelines/assemble`.            |
| `/pipelines`           | List pipelines; one-click enable/disable via `PATCH /pipelines/:id`.                              |
| `/pipelines/new`       | Create form (name, selector, content).                                                            |
| `/pipelines/:id`       | Edit form + **version history** + current rendered fragment (read-only).                         |

## Pipeline editor

- **Selector builder** (`src/components/SelectorEditor.tsx`): a controlled
  key/value editor for `Record<string, string>`. Empty selector = applies
  fleet-wide.
- **Content**: raw Alloy river fragment. Don't include root-level blocks
  like `logging`, `tracing`, or `remotecfg` — those must live in the
  bootstrap config (`examples/bootstrap.alloy`), not in remote-delivered
  modules. See [`docs/remotecfg.md`](./remotecfg.md) for the full contract.
- **Save** writes via `PATCH /pipelines/:id`, which the manager turns into a
  new `pipeline_versions` row (immutable audit trail) and updates the
  pipeline's `current_version` pointer. There's no "update in place" option
  by design.

## Assembled config preview

`POST /pipelines/assemble` is a new admin-only endpoint added for the UI.
Given `{ attributes: { env: "prod", role: "edge" } }` it runs the exact same
`assembleConfigFor` logic used by the Connect `GetConfig` RPC but **does
not** touch `remotecfg_collectors`. This makes it safe to use interactively.

On the collector detail page, the preview is seeded with the collector's
real reported attributes so the default view is "what would this collector
get right now?" Edit the attributes and re-assemble to simulate moves
between rollout rings, new label values, etc.

## Running the UI

### Dev mode (Vite + hot reload)

```bash
npm run dev:manager       # terminal 1 — manager on :9090
npm run dev:ui            # terminal 2 — UI on :5173
```

`vite.config.ts` proxies `/pipelines`, `/remotecfg`, and `/health` to
`http://localhost:9090`. CORS for `http://localhost:5173` is allowed by the
manager (see `apps/fleet-manager/src/server.ts`).

### Production (bundled into the manager image)

The `apps/fleet-manager/Dockerfile` builds `apps/fleet-ui` in the build
stage and copies `apps/fleet-ui/dist` into the runtime image. The manager
mounts it via `@fastify/static` at `/ui/`. Nothing else to configure:

```bash
docker compose up -d --build postgres fleet-manager
open http://localhost:9090/ui/
```

### Custom dist location

If you want to serve a UI build from a path other than
`apps/fleet-ui/dist`, set `FLEET_UI_DIR=/abs/path/to/dist` on the manager
process. If no dist is found the manager logs `fleet-ui not built (no dist
dir found); UI disabled` and runs API-only. This keeps the "just run the
API" developer path friction-free.

## File layout

```
apps/fleet-ui/
  index.html
  vite.config.ts        base: "/ui/" + dev proxy
  tailwind.config.js    dark palette via CSS variables
  src/
    main.tsx            React entry; wires BrowserRouter with basename
    App.tsx             route table
    index.css           Tailwind layers + semantic component classes
    api/
      client.ts         fetch wrapper + bearer attach + ApiError
      types.ts          response shapes
      pipelines.ts      CRUD + assembleForAttributes
      collectors.ts     listCollectors
    auth/
      TokenGate.tsx     localStorage token login screen
    components/
      Layout.tsx        sidebar + main outlet
      PageHeader.tsx    title / subtitle / actions
      Async.tsx         useAsync hook + AsyncBoundary
      CachedAsync.tsx   useCachedList — stale-while-revalidate
      Toaster.tsx       global toast viewport (mounted once in App)
      Pill.tsx          status tags
      Code.tsx          code/preview block
      SelectorEditor.tsx  key/value editor
      PipelineForm.tsx  shared create + edit form (useReducer)
    store/
      auth.ts           bearer token + gate status (Zustand)
      toasts.ts         notification queue (Zustand)
      cache.ts          list-response memory cache (Zustand)
    pages/
      Overview.tsx
      Collectors.tsx
      CollectorDetail.tsx
      Pipelines.tsx
      PipelineNew.tsx
      PipelineEdit.tsx
    lib/
      format.ts         shortHash / relativeTime / formatAttributes
```

## Extending

- **A new page**: add a file in `src/pages/`, register the route in
  `src/App.tsx`, link to it from `src/components/Layout.tsx` (NAV array).
- **A new API call**: add a thin wrapper in `src/api/*.ts` that delegates to
  `apiFetch`. Never call `fetch` directly from a component.
- **A theme tweak**: change the `--fleet-*` variables in
  `src/index.css`. Every component re-reads them via Tailwind tokens.
