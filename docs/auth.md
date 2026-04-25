# Authentication & Authorization

This document describes the identity, session, role-based access
control (RBAC), and API token model used by the Fleet Manager. It
covers Phase 1 (identity + RBAC + API tokens + local users) and the
Phase 2 SSO additions (OIDC, JIT provisioning, role sync, link/unlink
tools). For the operator-facing SSO admin guide — IdP recipes for
Keycloak / GitLab / Google / Auth0, the YAML schema, the failure-mode
table, and the UI walkthrough — see [docs/sso.md](sso.md).

## Big picture

Three sources of credentials all converge on the same `Actor`
representation, and every permission check goes through the same
middleware:

```
                          ┌──────────────────────┐
1. Bearer ADMIN_TOKEN ───►│                      │
2. Bearer  fmt_… token ──►│  resolveActor(req)   │── Actor ──► requirePermission(p)
3. Cookie fleet.sid ─────►│                      │
                          └──────────────────────┘
```

- **Actor**: the resolved caller. Has a `kind` (`env_token` / `user`
  / `api_token`), an optional user record, and a materialized
  `permissions: Set<Permission>`.
- **Permission**: an opaque string like `"pipelines.read"`. Routes
  declare which one they need; the middleware 401s/403s before the
  handler runs.

## The 14 permissions

Permissions name resource verbs. Adding a new one is a code change in
`apps/fleet-manager/src/auth/permissions.ts`, never a schema change.

| Permission         | Lets you                                                 |
| ------------------ | -------------------------------------------------------- |
| `pipelines.read`   | List/get pipelines, view assembled config preview        |
| `pipelines.create` | Create a new pipeline                                    |
| `pipelines.update` | Update an existing pipeline (creates a new version)      |
| `pipelines.delete` | Delete a pipeline                                        |
| `collectors.read`  | List collectors + view their assembled configs (admin/UI) |
| `collectors.poll`  | Call the `remotecfg` RPCs as an Alloy instance (`/collector.v1.CollectorService/*`). Granted by the built-in `agent` role. |
| `catalog.read`     | Browse the template catalog                              |
| `audit.read`       | View the audit log                                       |
| `users.read`       | List users + their role assignments                      |
| `users.write`      | Create/edit/disable users; assign roles; reset passwords; manage custom roles |
| `tokens.read`      | List **other users'** API tokens (own tokens are always visible) |
| `tokens.write`     | Create/revoke **other users'** API tokens (own-token management is always allowed) |
| `sso.read`         | View configured identity providers + the SSO Activity audit feed; run `Test connection` |
| `sso.write`        | Create/edit/delete identity providers; link/unlink local users to SSO identities |

`pipelines.create` and `pipelines.update` are split deliberately: it
lets you grant a role that can edit existing pipelines but can't
create new ones (e.g. "pipeline-maintainer").

`collectors.read` and `collectors.poll` are also split deliberately:
the first is "I want to look at what collectors exist in the UI" (a
human-grade permission), the second is "I AM a collector and I want
to pull my config" (a machine-grade permission). They live in
different roles and are never granted together by accident.

## Built-in roles

Four roles are seeded by migrations `1700000000003_identity.sql` and
`1700000000004_agent_role.sql`, and cannot be edited or deleted:

| Role     | Permissions                                                              |
| -------- | ------------------------------------------------------------------------ |
| `admin`  | Every permission.                                                        |
| `editor` | All `*.read` + `pipelines.create` + `pipelines.update` + `pipelines.delete`. |
| `viewer` | Every `*.read` (`pipelines`, `collectors`, `catalog`, `audit`).          |
| `agent`  | `collectors.poll` and **only** `collectors.poll`. Designed for tokens minted per Alloy instance. |

You can create additional **custom roles** via the UI (`Settings →
Roles`) or `POST /roles`. Custom roles can be edited or deleted; the
four built-ins cannot.

## Identity sources

### 1. Local users (email + password)

The default sign-in path. Backed by the `users` table; passwords are
hashed with bcrypt cost factor 12.

- Created via `POST /users` (gated by `users.write`) or via the UI's
  Users page.
- Sign in via `POST /auth/login`; the response sets a `fleet.sid`
  cookie and includes the actor + permissions.
- Self-service password change via `POST /auth/password`.
- Admins can reset any user's password via `POST /users/:id/password`;
  this also invalidates all of that user's sessions.

### 2. API tokens (programmatic)

Long-lived bearer tokens for `fleetctl`, Terraform, CI, and the
`@fleet-oss/sdk` package. Each token belongs to a user and carries an
explicit subset of that user's roles — so an admin can mint a
read-only CI token without granting it admin powers.

Token format:

```
fmt_<prefix>_<secret>
```

- `fmt_` — fixed marker so leaked tokens are easy to grep for.
- `<prefix>` — 8 chars; stored in `api_tokens.token_prefix` for
  display ("fmt_a1b2c3d4…") and as a fast lookup key.
- `<secret>` — 32 bytes of entropy, base64url. Only the SHA-256 of
  the **full** token is persisted (`api_tokens.token_hash`). Verification
  is timing-safe.

The plaintext is shown to the user **exactly once** at creation
(`POST /tokens` response → `token` field). Lose it, mint another.

#### Per-Alloy `agent` tokens

The remotecfg endpoints (`/collector.v1.CollectorService/*`, polled by
every Alloy instance) accept two bearer formats:

1. The legacy shared `AGENT_BEARER_TOKEN` env var (back-compat — every
   existing deployment uses this).
2. Any `fmt_…` API token whose actor carries `collectors.poll`. The
   built-in `agent` role grants only that permission; minting one
   token per Alloy instance with role `agent` gives you per-collector
   revocation, attribution via `api_tokens.last_used_at`, and an
   identity in `req.actor` that the handlers and request log can see.

Both paths coexist; the manager tries the legacy compare first (so
existing fleets see no per-poll latency change), and falls back to
the identity-system path. See `apps/fleet-manager/src/remotecfg/routes.ts`.

Polls are intentionally **not** audited (they fire every ~30s per
collector and would dwarf the rest of the audit feed). The
`api_tokens.last_used_at` column is the per-collector liveness
signal, and the request log captures every poll at debug level.

##### Provisioning agent tokens declaratively

Per-host token issuance is supported by both the Terraform provider
and the TypeScript SDK so you don't have to hand-roll API calls in CI:

**Terraform** (`terraform-provider-fleet`):

```hcl
data "fleet_roles" "all" {}

resource "fleet_user" "edge" {
  email    = "edge-host-01@fleet.local"
  password = "rotate-me-then-forget" # never used at runtime
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

resource "fleet_api_token" "edge" {
  name     = "edge-host-01"
  user_id  = fleet_user.edge.id
  role_ids = [data.fleet_roles.all.by_name["agent"]]
}

output "edge_token" {
  value     = fleet_api_token.edge.token
  sensitive = true
}
```

`fleet_api_token.token` is the plaintext bearer; the manager only
returns it once on Create, so the provider stores it in (sensitive)
state. Use a remote backend with KMS-encrypted state before scaling
this out.

**SDK** (`@fleet-oss/sdk`):

```ts
const sdk = new FleetClient({ endpoint, adminToken });
const t = await sdk.createAgentToken({
  name: "edge-host-01",
  user_id: serviceAccountId, // omit when called by a user actor
});
console.log(t.token); // fmt_… — drop into bootstrap.alloy and forget
```

`createAgentToken` looks up the built-in `agent` role and minting
fails fast if the manager is too old to ship it. For non-agent
tokens (CI, fleetctl, custom roles) use `createApiToken` directly.

### 3. SSO (OIDC)

Configure one or more identity providers via the `SSO_CONFIG_FILE`
YAML or directly through `Settings → Identity providers`. Sign-in is
strict-by-default:

- Group claim must map to at least one fleet role (otherwise the
  attempt is rejected with `no_groups_assigned`).
- An IdP-reported email that already belongs to a *local-password*
  user is rejected with `email_collision_local_user` — an admin must
  explicitly link the accounts via the Users page or
  `POST /users/:id/link-sso`.
- Roles are synced from group claims on every login. Manual role
  edits made on an SSO-managed user via the UI are overwritten on the
  next sign-in (the page warns about this in the badge tooltip).

Full operator guide, IdP recipes, failure-mode table, and the
YAML+DB-overlay semantics live in [docs/sso.md](sso.md). The Settings
→ SSO Activity page is a filtered audit-log view of `auth.sso.login`,
`auth.sso.rejected`, and `auth.sso.role_sync` rows for on-call.

### 4. `ADMIN_TOKEN` env var (break-glass)

The original auth path. Still works, still grants every permission.
Use it for:

- First boot (when `users` is empty) to call `POST /users` and create
  yourself an account.
- CI/CD pipelines you don't want to migrate yet.
- Recovery when you've locked yourself out.

The env token has no user record so audit events for it record
`actor_kind = "env_token"`, `actor_user_id = null`, `actor =
"admin-token:env"`.

## Resolution order

`resolveActor(req)` runs at the start of every admin request:

```
1. Authorization: Bearer <X>
   1a. X == process.env.ADMIN_TOKEN       → env-token actor (all perms)
   1b. X matches an api_tokens row        → that token's roles → perms
   1c. neither                            → 401 (no fall-through to cookie)
2. cookie fleet.sid maps to a session     → that user's roles → perms
3. nothing presented                      → 401
```

The "Bearer present but invalid → 401, don't fall through to cookie"
rule prevents an attacker who steals a leaked bearer from being able
to bypass it by also presenting their own cookie.

## Sessions

- Stored server-side in `sessions` table. Cookie carries only the
  random opaque session id (signed with `SESSION_COOKIE_SECRET`).
- TTL: 7 days. Sliding refresh — every request bumps `last_seen` and,
  if more than half the TTL has elapsed, extends `expires_at`.
- Logout (`POST /auth/logout`) deletes the row and clears the cookie.
  Local logout only — the IdP is not notified (when OIDC ships).
- Disabling a user or resetting their password invalidates **all**
  their sessions immediately so a fired user can't keep working
  until cookie expiry.
- Hourly background job purges expired rows from `sessions`.

## Bootstrapping the first admin

When the `users` table is empty at startup, the manager checks two
optional env vars:

```env
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=changeme-on-first-login
```

If both are set, a single user is created with the built-in `admin`
role. The bootstrap is idempotent: once the table has any row, it's
a no-op on every subsequent boot.

If you don't set the bootstrap vars, the server logs:

```
WARN  no users exist and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set —
      use ADMIN_TOKEN to POST /users, or restart with the bootstrap env vars set
```

You can then:

1. Use `ADMIN_TOKEN` as a bearer to `POST /users` and create your
   first account by hand, or
2. Restart with the env vars set.

## Migrating from ADMIN_TOKEN

Existing deployments don't need to do anything to preserve `ADMIN_TOKEN`:

- The env var still works as a bearer.
- The legacy `/legacy/...` REST agent endpoints continue to accept it.
- Existing audit events keep their `actor` strings.

Recommended migration path:

1. Set `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD`, restart.
2. Sign in to the UI; create per-engineer accounts under `Settings →
   Users` with the `editor` or `viewer` role.
3. Each engineer signs in and mints a personal API token under
   `Settings → API tokens` for `fleetctl` / Terraform / CI use.
4. Rotate the shared `ADMIN_TOKEN` to a value nobody knows. Keep it
   set so the break-glass path remains available.

## Audit log integration

Every admin mutation writes an `audit_events` row inside the same
transaction as the mutation itself, so the audit log is always
consistent with the state of the system. The identity migration added
four nullable columns to `audit_events`:

| Column           | Set for `env_token` | Set for `user` | Set for `api_token` |
| ---------------- | ------------------- | -------------- | ------------------- |
| `actor`          | `admin-token:env`   | `user:<email>` | `api-token:<id>`    |
| `actor_kind`     | `env_token`         | `user`         | `api_token`         |
| `actor_user_id`  | NULL                | user uuid      | owner user uuid     |
| `actor_email`    | NULL                | email          | email               |
| `actor_token_id` | NULL                | NULL           | api_token uuid      |

Old rows have all four new columns NULL — by design, so existing
queries against `actor` keep returning the same values they always did.

### Actions covered

| `target_kind` | `action`                | Written from                                       |
| ------------- | ----------------------- | -------------------------------------------------- |
| `pipeline`    | `pipeline.create`       | `POST /pipelines`                                  |
| `pipeline`    | `pipeline.update`       | `PATCH /pipelines/:id`                             |
| `pipeline`    | `pipeline.delete`       | `DELETE /pipelines/:id`                            |
| `user`        | `auth.login`            | `POST /auth/login` (success only)                  |
| `user`        | `auth.login.locked`     | `POST /auth/login` against a locked account, OR the failure that triggered the lock |
| `user`        | `auth.logout`           | `POST /auth/logout` (only if a session existed)    |
| `user`        | `auth.password.change`  | `POST /auth/password` (self-service)               |
| `user`        | `user.create`           | `POST /users`                                      |
| `user`        | `user.update`           | `PATCH /users/:id` (diff in `metadata.changed`)    |
| `user`        | `user.unlock`           | `PATCH /users/:id` `{ "unlock": true }` (admin clears a lockout) |
| `user`        | `user.password.reset`   | `POST /users/:id/password` (admin-initiated)       |
| `user`        | `user.delete`           | `DELETE /users/:id`                                |
| `role`        | `role.create`           | `POST /roles`                                      |
| `role`        | `role.update`           | `PATCH /roles/:id` (diff in `metadata.changed`)    |
| `role`        | `role.delete`           | `DELETE /roles/:id`                                |
| `api_token`   | `token.create`          | `POST /tokens` (logs `token_prefix`, never the plaintext) |
| `api_token`   | `token.revoke`          | `DELETE /tokens/:id`                               |

Login *failures* and 401/403 rejections are intentionally not audited
— they're noisy and do not indicate a successful state change. Two
exceptions for `/auth/login`: an attempt against an already-locked
account, and the specific bad-password attempt that tips the user
over the lockout threshold, are recorded as `auth.login.locked` so
operators can see who was being credential-stuffed.

### Brute-force protection

`POST /auth/login` runs three layers, all in the manager:

1. **bcrypt cost factor 12** (~250ms per attempt) on every guess —
   including locked accounts, so the response time can't be used to
   fingerprint lock state.
2. **Per-IP rate limit** via `@fastify/rate-limit`: 10 attempts per
   15 minutes, keyed on `req.ip` (which respects `trustProxy: true`).
3. **Per-account lockout**: 5 consecutive failures stamp
   `users.locked_until = now() + 15 minutes`. The next attempt
   returns `423 account_locked` with a `locked_until` timestamp;
   bcrypt still runs to keep timing identical to the unlocked path.

A successful login clears the failure counter. An admin can clear it
manually at any time:

```http
PATCH /users/:id
Content-Type: application/json
Authorization: Bearer fmt_…

{ "unlock": true }
```

The response is the standard updated-user shape; the action is
audited as `user.unlock`.

The same per-IP rate limit applies to `GET /auth/sso/start/:id` so an
attacker cannot use the SSO start endpoint to amplify outbound
traffic at an IdP (or, combined with a misconfigured-but-allowed
issuer, at any HTTP target).

### Secret hygiene

The audit log MUST be safe to share with auditors. The recording
helpers therefore:

- **never** log plaintext passwords (neither old nor new),
- **never** log plaintext API tokens — only `token_prefix`, which is
  also returned by `GET /tokens` and is not a credential on its own,
- log session ids on `auth.login` / `auth.logout` because they are
  opaque per-session identifiers, not secrets that grant access on
  their own (the cookie is signed; the raw id alone is useless).

## API summary

| Method | Path                       | Permission       | Notes                                  |
| ------ | -------------------------- | ---------------- | -------------------------------------- |
| POST   | `/auth/login`              | none             | Sets `fleet.sid` cookie.                |
| POST   | `/auth/logout`             | authenticated    | Idempotent.                             |
| GET    | `/auth/me`                 | authenticated    | Returns the resolved actor + permissions. |
| POST   | `/auth/password`           | authenticated    | Self-service, requires current password. |
| GET    | `/users`                   | `users.read`     | List with roles.                       |
| GET    | `/users/:id`               | `users.read`     |                                        |
| POST   | `/users`                   | `users.write`    | Optional `role_ids`.                   |
| PATCH  | `/users/:id`               | `users.write`    | Update name, disabled, role_ids.       |
| POST   | `/users/:id/password`      | `users.write`    | Forces re-login on every device.       |
| DELETE | `/users/:id`               | `users.write`    | Refuses to delete self.                |
| GET    | `/users/:id/tokens`        | `tokens.read` (or self) | List a user's tokens.            |
| GET    | `/roles`                   | `users.read`     | Built-ins + custom.                    |
| POST   | `/roles`                   | `users.write`    | Custom roles only.                     |
| PATCH  | `/roles/:id`               | `users.write`    | Built-ins refuse.                      |
| DELETE | `/roles/:id`               | `users.write`    | Built-ins refuse.                      |
| GET    | `/tokens`                  | authenticated    | Default scope = own; `?user=<id>` requires `tokens.read`. |
| POST   | `/tokens`                  | authenticated (own) or `tokens.write` (other) | Returns plaintext ONCE. |
| DELETE | `/tokens/:id`              | authenticated (own) or `tokens.write` (other) |                  |

The legacy `/legacy/*` REST agent endpoints continue to require
`ADMIN_TOKEN` (env or DB-backed API token) as before.

## SSO

OIDC SSO is delivered. See [docs/sso.md](sso.md) for the operator
guide (provider recipes, YAML schema, UI walkthrough, failure modes).

Quick summary of the API/data-model additions:

- `users.oidc_issuer` + `users.oidc_subject` are populated for
  SSO-managed users (partial unique index ensures one local user per
  `(issuer, subject)`).
- `password_hash` is nullable; SSO-only users have no local password.
- `identity_providers` + `identity_provider_role_mappings` tables
  back the YAML+DB-overlay configuration model.
- `auth.sso.login` / `auth.sso.rejected` / `auth.sso.role_sync` audit
  actions plus `sso.provider.*`, `sso.user_link`, `sso.user_unlink`
  for admin mutations.

SAML is deferred behind the same `SsoProvider` interface that backs
OIDC; adding it later does not require schema changes.
