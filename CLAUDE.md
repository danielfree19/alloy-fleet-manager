# CLAUDE.md — Handoff & Context Recovery

> **Purpose**: When the conversation context is close to its limit and we
> need to start fresh (or hand off mid-task), read this file FIRST. It's
> the cheapest way back into the project's mental model — much cheaper than
> re-reading the whole repo or the prior transcript.
>
> Last updated: 2026-04-25 (Phase 2 SSO — OIDC delivered;
> open-source release plumbing landed: Apache-2.0 LICENSE,
> CONTRIBUTING/SECURITY/COC/MAINTAINERS, GitLab CI pipeline,
> GoReleaser configs for the Terraform provider + fleetctl, npm
> publish wiring for `@fleet-oss/sdk`, multi-arch Docker buildx,
> automated GitHub mirror push. See `docs/ci-cd.md` and
> `docs/release.md`.
> Security hardening pass — `@fastify/helmet` (strict CSP +
> `frame-ancestors 'none'` + HSTS), `@fastify/rate-limit` on
> `/auth/login` and `/auth/sso/start/:id`, per-account lockout
> (5 failures / 15 min, audited as `auth.login.locked` +
> admin-clear via `PATCH /users/:id { unlock: true }` →
> `user.unlock`), pino redaction of auth headers + body fields,
> `recordAuditEvent` deny-list sanitizer, OIDC SSRF guard
> (`auth/sso/url-guard.ts`: pre-flight + custom `lookup` into
> `openid-client` via `custom.setHttpOptionsDefaults`).
> First test harness — `vitest` in `apps/fleet-manager`
> (`npm run test -w apps/fleet-manager`).).

---

## 0. Hard rules (from the user, must follow)

These came from `<user_rules>` and apply to every change you make:

1. **Prefer Node.js + Go.** This is the polyglot baseline; don't introduce
   Python/Rust/etc. without explicit user approval.
2. **Document everything you do** and **document app functionality**. After
   any non-trivial change update the relevant `docs/*.md` (and this file
   when scope shifts). README links are the table of contents.
3. **Don't rewrite code without checking that you don't cancel old logic.**
   Old code paths are often deliberately preserved (e.g. the legacy agent,
   the legacy `AGENT_BEARER_TOKEN` path). Read the surrounding code and
   any preceding docs before deleting or replacing.

Project-wide conventions worth keeping in mind:

- Code comments explain **why / trade-offs / non-obvious intent**, never
  narrate "what" the code does. (See past commits — that's the bar.)
- Imports of internal modules in `apps/fleet-manager` use the `.js`
  extension even from `.ts` files (NodeNext module resolution).
- Biome is the JS linter. Several pre-existing patterns produce warnings
  (`req.actor!` non-null assertions, `autoFocus`, static `id` props).
  Don't fight pre-existing patterns; follow whatever the file already
  uses. Only fix lints **you** introduced.

---

## 1. What this project is

Self-hosted, vendor-neutral replacement for Grafana Cloud Fleet Management.
Built around Grafana Alloy's native `remotecfg` block — Alloy itself is
the agent, no sidecar.

Top-level mental model:

```
[ Operator / CI / fleetctl / Terraform / SDK ]
              │ Bearer admin or fmt_… token
              ▼
       ┌──────────────────┐
       │  Fleet Manager   │  Fastify (Node.js, TS), Postgres
       │  /pipelines CRUD │  ────────► audit_events
       │  /users /roles   │
       │  /tokens /catalog│
       │  Connect RPC:    │
       │  collector.v1.   │  ◄── Alloy `remotecfg` polls
       │  CollectorService│      (legacy AGENT_BEARER_TOKEN OR
       └──────────────────┘       fmt_… token w/ collectors.poll)
```

The full architecture doc is `docs/architecture.md`. Read it once if you
haven't.

---

## 2. Repo layout (only the parts you'll edit)

```
apps/
  fleet-manager/        # Fastify API — primary (remotecfg) + legacy (REST)
    src/
      server.ts         # Top-level bootstrap; route registration order matters
      config.ts         # zod-parsed env config
      auth/             # Identity + RBAC: permissions.ts, middleware.ts,
                        # users.ts, sessions.ts, password.ts
      remotecfg/        # Connect RPC handler for Alloy polls
      routes/           # auth.ts users.ts tokens.ts pipelines.ts catalog.ts
                        # audit.ts collectors.ts (+ legacy: configs.ts etc.)
      services/         # audit.ts (recordAuditEvent), assemble.ts, etc.
      db/migrations/    # node-pg-migrate SQL — run via `npm run migrate`
  fleet-ui/             # Vite + React + TS + Tailwind admin SPA, served at /ui/
    src/
      api/              # types.ts (mirrors backend DTOs) + apiFetch helper
      pages/            # Top-level routed pages
      components/       # Shared bits: AuditEventList, PageHeader, …
      stores/           # Zustand stores (auth, toasts, cache)
      App.tsx           # Routing — public /login + RequireAuth-wrapped layout
  fleet-agent/          # LEGACY Node.js agent. Preserved, NOT the primary path.

packages/
  sdk/                  # @fleet-oss/sdk — TS client for Node/browser
    src/{types,client,errors,index}.ts
  shared/               # Shared TS types + zod schemas

terraform/
  provider-fleet/       # Native Go provider (HashiCorp Plugin Framework v1)
    internal/provider/
      provider.go       # Schema + Configure
      client.go         # stdlib HTTP wrapper + DTOs
      convert.go        # tfsdk ↔ DTO helpers
      pipeline_resource.go     pipeline_data_source.go
      pipelines_data_source.go collectors_data_source.go
      user_resource.go         api_token_resource.go
      roles_data_source.go
  examples/basic/main.tf

cmd/fleetctl/           # Go CLI (cobra)

proto/collector/v1/     # Vendored Apache-2.0 protobuf

catalog/templates.json  # 27 curated pipeline templates

docs/                   # Index lives in README.md
```

`apps/fleet-agent` is **legacy**. Don't refactor it unless asked. Same for
`apps/fleet-manager/src/routes/configs.ts` and friends — those are the
old REST surface for `fleet-agent`, kept for back-compat.

---

## 3. Tech stack quick reference

- **Manager**: Node.js 20+, Fastify, TypeScript (NodeNext), Postgres,
  `node-pg-migrate`, `zod`, `pino`, `undici`, `@fastify/cookie`, `bcryptjs`.
- **UI**: Vite + React + TypeScript + Tailwind CSS, React Router, Zustand
  for global state, `useReducer` for complex local state (e.g.
  `PipelineForm`).
- **SDK**: zero runtime deps; pure ES modules; uses global `fetch`.
- **TF provider**: Go, HashiCorp Plugin Framework v1, stdlib HTTP. Address
  is `fleet-oss/fleet`.
- **CLI** (`fleetctl`): Go, cobra.
- **Validation**: `alloy fmt --check` (real Alloy binary; falls back to a
  light builtin if the binary isn't available).

Workspaces are npm `workspaces`: `packages/*` and `apps/*`.

---

## 4. Build / verify commands

Run these any time you've made non-trivial changes. They're fast.

```bash
# Manager (TS typecheck — no emit)
npm run typecheck -w apps/fleet-manager

# UI
npm run typecheck -w apps/fleet-ui
npm run build     -w apps/fleet-ui

# SDK
npm run -w @fleet-oss/sdk build

# Whole monorepo (any workspace that defines the script)
npm run build
npm run typecheck

# Terraform provider
cd terraform/provider-fleet && go build ./... && go vet ./...

# fleetctl
cd cmd/fleetctl && go build ./... && go vet ./...
```

`ReadLints` (Biome) on JS/TS files you edited is also useful — but
remember to **only fix lints you introduced**.

### Full 0-to-100 e2e (compose + Terraform + Alloy + prom-sink)

```bash
scripts/e2e-terraform.sh                          # full lifecycle, default teardown
ENABLE_TEARDOWN=0      scripts/e2e-terraform.sh   # leave stack up for inspection
COMPOSE_BIN="podman compose" scripts/e2e-terraform.sh   # force a specific compose CLI
```

Compose CLI is **auto-detected** — the script probes `docker compose`,
`podman compose`, `podman-compose`, and legacy `docker-compose` in that order
and picks the first that responds to `<cli> version`. Set `COMPOSE_BIN` only
when you have multiple installed and want to force one.

Verifies, in one shot: provider CRUD on pipelines, agent api token authentication
against `remotecfg`, legacy `AGENT_BEARER_TOKEN` back-compat, RBAC scoping
(agent token rejected on `/pipelines`), Alloy registration, end-to-end metrics
flow into `prom-sink`, and zero-drift on re-apply. See
`docs/e2e-terraform.md` for the full breakdown of what each phase catches.

---

## 5. Identity & RBAC — the bit most likely to bite you

This was the largest area of recent work. Internalize this before
touching anything in `apps/fleet-manager/src/auth/` or any tokens/users
route.

### 5.1 The 12 permissions (canonical, in `auth/permissions.ts`)

| Permission           | Use                                                   |
| -------------------- | ----------------------------------------------------- |
| `pipelines.read`     | List/inspect pipelines                                |
| `pipelines.create`   | POST /pipelines                                       |
| `pipelines.update`   | PATCH /pipelines/:id                                  |
| `pipelines.delete`   | DELETE /pipelines/:id                                 |
| `collectors.read`    | List collectors via /remotecfg/collectors             |
| `collectors.poll`    | **Alloy** auth for /collector.v1.CollectorService/*   |
| `catalog.read`       | List/install templates                                |
| `audit.read`         | Read /audit                                           |
| `users.read`         | List/inspect users + roles                            |
| `users.write`        | Create/update/disable users; manage custom roles      |
| `tokens.read`        | List anyone's tokens                                  |
| `tokens.write`       | Create tokens for other users; revoke others' tokens  |

### 5.2 The 4 built-in roles

| Role     | Permissions                                                 |
| -------- | ----------------------------------------------------------- |
| `admin`  | All 12                                                      |
| `editor` | `pipelines.*`, `collectors.read`, `catalog.read`, `audit.read`|
| `viewer` | `*.read`                                                    |
| `agent`  | **Only** `collectors.poll`. For per-Alloy api tokens.       |

### 5.3 Three auth paths into the manager

1. **Cookie session** (`fleet.sid`, signed). Created by `POST /auth/login`.
   Used by the UI.
2. **`fmt_…` API token** as `Authorization: Bearer …`. Used by `fleetctl`,
   Terraform, CI, the SDK, and **per-Alloy `agent` tokens**.
3. **`ADMIN_TOKEN` env var** as `Authorization: Bearer …`. Break-glass.
   `actor.kind === "env_token"`, no `userId`, all permissions.

`resolveActor(req)` enforces resolution order; see `docs/auth.md`.

### 5.4 `remotecfg` dual-path auth (this trips people up)

The Alloy `remotecfg` polls hit `/collector.v1.CollectorService/*` and
have **two valid auth modes**, in this order:

1. Legacy shared `AGENT_BEARER_TOKEN` (timing-safe compare, no DB lookup).
   Every existing deployment uses this; never remove it.
2. Any `fmt_…` token with `collectors.poll` (so any role that includes it,
   in practice the built-in `agent` role).

Implemented in `apps/fleet-manager/src/remotecfg/routes.ts` →
`makeRemotecfgAuth`. Polls are intentionally **not audited**
(would dwarf the audit feed); `api_tokens.last_used_at` is the
liveness signal.

### 5.5 Last-admin-lockout guard

`PATCH /users/:id` and `DELETE /users/:id` refuse to disable/delete the
last active admin. See `routes/users.ts`. If you add new "remove privilege"
paths, plug them into the same guard (`countActiveAdmins` /
`userHasAdminRole`).

### 5.6 Audit logging — what's covered and what isn't

15 actions, all with structured actor columns
(`actor_kind`, `actor_user_id`, `actor_email`, `actor_token_id`):

- **Pipelines**: `pipeline.create`, `pipeline.update`, `pipeline.delete`
- **Auth**: `auth.login`, `auth.logout`, `auth.password.change`
- **Users**: `user.create`, `user.update`, `user.delete`, `user.password.reset`
- **Roles**: `role.create`, `role.update`, `role.delete`
- **Tokens**: `token.create`, `token.revoke`

Plaintext secrets are NEVER logged. Tokens log `token_prefix` only.

`remotecfg` polls are NOT audited.

---

## 6. Major features delivered (timeline)

In rough order, useful for "wait, when did X land?":

1. **Phase 0 — Pipelines & remotecfg.** REST CRUD over pipelines,
   `Connect-Go` RPC for Alloy, immutable `pipeline_versions`, audit log.
2. **UI v1.** Vite/React/TS/Tailwind admin SPA at `/ui/`. Includes
   `PipelineForm` driven by `useReducer`; auth driven by Zustand stores.
3. **Terraform provider.** Native Go (HashiCorp Plugin Framework v1).
   Initial: `fleet_pipeline` resource + data sources.
4. **Operational extras.** `fleetctl` Go CLI, `@fleet-oss/sdk` TS client,
   `alloy fmt --check` validation, audit log, template catalog
   (now 27 templates in `catalog/templates.json`).
5. **Phase 1 — Identity + RBAC.** Local users (bcrypt), Postgres-backed
   sessions, 12 permissions, 4 built-in roles, custom roles, `fmt_…` API
   tokens with privilege containment, admin UI for managing all of it,
   last-admin-lockout guard, full audit coverage of identity actions.
6. **Per-Alloy agent tokens.** `collectors.poll` permission + built-in
   `agent` role. `remotecfg` accepts both the legacy shared
   `AGENT_BEARER_TOKEN` and `fmt_…` tokens with `collectors.poll`.
7. **TF + SDK identity surface.** New TF resources `fleet_user`,
   `fleet_api_token`; new data source `fleet_roles`. New SDK methods
   covering identity + tokens, with a `createAgentToken` convenience.
8. **Phase 2 SSO (OIDC) — delivered.** See `docs/sso.md`. Highlights:
   - YAML+DB-overlay multi-IdP config: `SSO_CONFIG_FILE` (GitOps
     defaults) merged with `identity_providers` rows (UI overrides).
     UI-managed rows shadow YAML rows by `id`.
   - `SsoProvider` abstraction (`apps/fleet-manager/src/auth/sso/`)
     with an `OidcProvider` impl using `openid-client` (PKCE, signed
     `fleet.sso_state` cookie carrying state+nonce+pkce+return_to).
   - JIT provisioning gated on a non-empty group→role mapping; per-
     login role sync (groups are the source of truth for SSO users).
   - Two new permissions: `sso.read` (view + Test connection),
     `sso.write` (CRUD providers + link/unlink). `admin` gets both.
   - Admin tooling: `Settings → Identity providers` (incl. "Test
     connection"), `Settings → SSO Activity` (filtered audit feed),
     and Users page badge + Link/Unlink row actions.
   - New audit actions: `auth.sso.login`, `auth.sso.rejected` (with a
     `reason` enum mirrored to `?sso_error=` on the login page),
     `auth.sso.role_sync` (only on diff), and `sso.provider.*` /
     `sso.user_link` / `sso.user_unlink` for admin mutations.
9. **Open-source release plumbing — delivered.** The repo is now ready
   to publish. Source of truth is **GitLab**; **GitHub** is a read-only
   mirror updated by CI. Apache-2.0 license at the root with NOTICE
   for vendored Alloy proto + `alloy` binary.
   - Community files: `CONTRIBUTING.md` (with DCO sign-off), `CODE_OF_CONDUCT.md`
     (Contributor Covenant 2.1), `SECURITY.md` (private disclosure flow),
     `MAINTAINERS.md`, `CHANGELOG.md` (Keep a Changelog format).
   - GitLab pipeline at `.gitlab-ci.yml` with stages: lint (DCO + yamllint)
     → build (npm + 2 Go modules) → test (manager smoke-boot against
     ephemeral postgres + Go unit tests) → smoke (`scripts/e2e-terraform.sh`
     in DinD, default-branch / tags / nightly only) → release (tag-only)
     → mirror (GitHub `git push --mirror`). `interruptible: true` everywhere
     so MR pushes auto-cancel.
   - Tag-only release jobs: multi-arch `fleet-manager` image
     (`linux/amd64,linux/arm64`) via `docker buildx`, GoReleaser for the
     Terraform provider (GPG-signed `SHA256SUMS` + Registry-shaped layout
     and `terraform-registry-manifest.json`), GoReleaser for `fleetctl`
     (multi-OS archives), and `npm publish --access public --provenance`
     for `@fleet-oss/sdk`.
   - **The SDK was renamed from `@fleet/sdk` to `@fleet-oss/sdk`** so
     the npm scope matches the existing Go module org
     (`github.com/danielfree19/...`). Internal TS code never imported the
     SDK by package name (only docs did), so this is a safe rename.
     Lockfile and all docs were updated.
   - GitHub mirror uses an **ed25519 deploy key** (base64-encoded into
     the `GITHUB_DEPLOY_KEY` CI variable) with write access on the
     mirror only — preferred over a PAT. Job is fail-soft: if the key
     isn't configured, the job logs "skipping" and exits 0.
   - Operator docs: `docs/ci-cd.md` (every job, every CI variable, key
     generation recipes) and `docs/release.md` (the tagging recipe,
     Terraform Registry onboarding, npm scope setup, hotfix flow,
     yank flow, verification commands).
   - GitLab issue/MR templates and `CODEOWNERS` live under `.gitlab/`.
     `.yamllint.yml` config lives at the repo root.

---

## 7. Pending / planned (not yet started)

- **Phase 2 SAML.** OIDC SSO is delivered (see §6). SAML is deferred
  behind the same `SsoProvider` abstraction that backs OIDC. No schema
  changes required to add it; drop a new provider impl in
  `apps/fleet-manager/src/auth/sso/saml.ts`, plumb it through the
  registry's `makeProvider` switch on `cfg.kind`, and accept `'saml'`
  in the YAML schema + admin POST body.
- **GitOps sync.** Watch a Git repo, materialize pipelines from it.
- **Staged/canary rollouts** — a controller layer on top of selectors.
- **Per-collector mTLS.**
- **Manager self-observability** (`/metrics` Prometheus endpoint on
  the manager).

---

## 8. Gotchas / context-saving notes

Things you'd otherwise discover the slow way:

- **`req.actor!` is the project pattern.** Routes that go through
  `requireAuthenticated` / `requirePermission` know the actor exists;
  the non-null assertion is intentional. Biome warns; ignore.
- **Stale LSP errors in `server.ts`.** The IDE's typechecker sometimes
  reports `Cannot find module './routes/foo.js'` for routes that exist.
  Re-running `npm run typecheck` is the source of truth — if it passes,
  the LSP is just lagging.
- **Manager response shapes vary slightly per route.** `POST /users`
  doesn't include `updated_at`; `PATCH /users/:id` does. The Terraform
  `user_resource.go` deals with this by always re-fetching via
  `GET /users/:id` after a write. Apply the same pattern if you add
  new routes that don't return the full row.
- **Tokens carry an intersection of roles.** `api_token.roles` must be
  a subset of the owner's roles (privilege containment, enforced by
  `tokens.ts`). Don't bypass — it's a hard invariant.
- **Plaintext token is returned exactly once**, by `POST /tokens`.
  `GET /tokens/:id` (added recently) returns the same shape minus
  `token`. The TF resource stores plaintext in (sensitive) state and
  warns operators in the README.
- **`fleet_api_token` is RequiresReplace on every editable attribute.**
  The manager has no in-place modify path for tokens. Don't try to
  add an Update.
- **The legacy agent path (`fleet-agent`, `routes/configs.ts`,
  `routes/collectors.ts`) is preserved.** Do not delete or modify
  unless explicitly asked.
- **Alloy `local_attributes` debugging.** When `attributes` filtering
  in `remotecfg` blocks looks broken, check the wire by setting
  `level = "debug"` in the bootstrap `logging` block — see
  `docs/remotecfg.md`.

---

## 9. Context-recovery checklist (when resuming)

Use this when you're starting fresh and context is tight:

1. Read this file end-to-end (you're here).
2. Skim `README.md` for the docs index.
3. Read the doc(s) covering the area you're about to touch:
   - identity work → `docs/auth.md`, `docs/auth-testing.md`
   - remotecfg work → `docs/remotecfg.md`
   - TF work → `docs/terraform.md` and
     `terraform/provider-fleet/README.md`
   - SDK work → `docs/sdk.md`
   - UI work → `docs/ui.md`, `docs/state.md`
   - schema/migration → `docs/data-model.md` and the most recent
     `apps/fleet-manager/src/db/migrations/*.sql`
4. If a tool/agent transcript is available, search it (don't read it
   linearly) for the keywords you actually care about.
5. Run the build/typecheck commands in §4 once before editing — if
   anything is already broken, you'll know it wasn't your change.
6. After editing, run those same commands again. Update this file's
   "Last updated" line and §6 if you've shipped a new feature.

---

## 10. When in doubt

- The user prefers **focused, scoped changes** over big rewrites.
- If a request is ambiguous, switch to plan mode and ask — don't guess.
- If a feature would touch the legacy agent or remove an old code path,
  stop and confirm with the user first (rule §0.3).
- Update the relevant `docs/*.md` whenever you ship behaviour changes
  (rule §0.2). This handoff file should be amended for sweeping changes
  too.
