# SSO (OIDC)

Self-hosted Fleet Manager supports Single Sign-On via OIDC. SAML is
deliberately deferred behind the same `SsoProvider` abstraction; if
your IdP only speaks SAML, file an issue.

This document is the operator guide. For the full identity / RBAC /
audit model that SSO sits on top of, see [docs/auth.md](auth.md).

## TL;DR

1. Decide where your provider configs live: a YAML file (GitOps) or
   the UI (admins). You can mix — YAML seeds defaults, UI rows
   override per provider.
2. Set `SSO_CONFIG_FILE=/etc/fleet-manager/sso.yaml` (or any path) on
   the manager process if you want to bootstrap from YAML.
3. Configure at least one **group → role mapping** per provider — a
   user whose IdP groups don't map to any fleet role is rejected with
   `no_groups_assigned`. There's no "default role" knob.
4. The first SSO sign-in for a given `(issuer, subject)` JIT-creates
   a local users row and applies the mapped roles. Subsequent
   sign-ins re-sync roles from the IdP — manual role edits made via
   the UI are overwritten on next login.

## Architecture

```mermaid
sequenceDiagram
    participant B as Browser
    participant M as fleet-manager
    participant Y as sso.yaml
    participant DB as Postgres
    participant I as IdP
    B->>M: GET /auth/providers
    M->>Y: load YAML (defaults)
    M->>DB: SELECT identity_providers (overrides)
    M-->>B: [{id, displayName, kind}]
    B->>M: GET /auth/sso/start/keycloak
    M->>M: state+nonce+PKCE; cookie 'fleet.sso_state'
    M-->>B: 302 to IdP /authorize
    B->>I: /authorize
    I-->>B: 302 callback?code=...
    B->>M: GET /auth/sso/callback/keycloak
    M->>I: POST /token (PKCE verifier)
    I-->>M: id_token + userinfo (sub, email, groups)
    M->>M: validate; map groups->roles; REJECT if empty
    M->>DB: find by (issuer,sub) | JIT create | sync roles
    M->>DB: createSession
    M-->>B: Set-Cookie fleet.sid; 302 /ui
```

## The two configuration sources

| Source | Wins on conflict | Use case |
| ------ | ---------------- | -------- |
| YAML (`SSO_CONFIG_FILE`) | seeded once on boot | GitOps; bootstrap; canonical IaC |
| Database (`identity_providers`, `source='ui'`) | yes — DB row overlays YAML by `id` | quick fixes; rotating a client_secret without a deploy |

The registry merges these on every mutation:

- A YAML provider with no DB row → used as-is, badged "managed via
  YAML" in the UI.
- An admin edits a YAML provider in the UI → a `source='ui'` row is
  inserted/updated. Subsequent reads use the DB row, badged "managed
  in UI". The YAML file is left alone.
- A UI-only provider has no YAML counterpart — `Delete` works in the
  UI. Deleting a YAML-only provider returns 409 with a hint to edit
  the YAML file.

## YAML schema

Reference: `examples/sso.yaml.example`. Minimum:

```yaml
providers:
  - id: keycloak
    kind: oidc
    display_name: Keycloak
    issuer: https://kc.example.com/realms/fleet
    client_id: fleet-manager
    client_secret: ${env:KEYCLOAK_CLIENT_SECRET}
    redirect_uri: https://fleet.example.com/auth/sso/callback/keycloak
    scopes: ["openid", "email", "profile", "groups"]
    groups_claim: groups
    role_mappings:
      "/fleet-admins": admin
      "/fleet-editors": editor
      "/fleet-readers": viewer
```

Field reference:

| Field | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `id` | slug | required | Stable identifier — appears in callback URL, audit metadata, and DB rows. Lowercase + `[a-z0-9_-]` only. |
| `kind` | enum | required | Only `oidc` is supported in this release. |
| `display_name` | string | required | Shown on the login button and in the UI. |
| `issuer` | URL | required | Used for OIDC discovery (`<issuer>/.well-known/openid-configuration`) and stored on `users.oidc_issuer` for JIT users. |
| `client_id` | string | required | OAuth2 client id registered with the IdP. |
| `client_secret` | string | required | Use `${env:VAR}` interpolation — never commit secrets to YAML. |
| `redirect_uri` | URL | required | Must exactly match what the IdP knows. The path is `/auth/sso/callback/<id>`. |
| `scopes` | string[] | `["openid","email","profile"]` | Add `groups` (or whatever your IdP requires) to receive group claims. |
| `groups_claim` | string | `groups` | Dot-path into id_token / userinfo for nested claims (e.g. `realm_access.roles`). |
| `role_mappings` | object | `{}` | `<group_value>: <role_name>`. The role name must exist in the `roles` table (built-in or custom). At least one mapping is required for any user to sign in. |

Environment interpolation uses the `${env:VARNAME}` syntax. Bare
`${VARNAME}` is not supported — we want the prefix to be unambiguous
in YAML diffs.

## Provider recipes

The minimum config you need per IdP. All assume the manager is
reachable at `https://fleet.example.com`. Replace with your own host.

### Keycloak

In the realm:

1. **Clients → Create**
   - Client type: OpenID Connect
   - Client ID: `fleet-manager`
   - Authentication flow: Standard flow + `Client authentication` ON
   - Valid redirect URIs: `https://fleet.example.com/auth/sso/callback/keycloak`
2. **Clients → fleet-manager → Client scopes → Default client scopes**
   - Add the `groups` scope (create one if it doesn't exist; map a
     `Group Membership` token mapper that emits the claim `groups`).
3. Copy the client secret from the **Credentials** tab.

YAML:

```yaml
- id: keycloak
  kind: oidc
  display_name: Keycloak
  issuer: https://kc.example.com/realms/fleet
  client_id: fleet-manager
  client_secret: ${env:KEYCLOAK_CLIENT_SECRET}
  redirect_uri: https://fleet.example.com/auth/sso/callback/keycloak
  scopes: ["openid", "email", "profile", "groups"]
  groups_claim: groups
  role_mappings:
    "/fleet-admins": admin
    "/fleet-editors": editor
    "/fleet-readers": viewer
```

### GitLab

In your GitLab instance (self-hosted or gitlab.com):

1. **Admin → Applications → New** (or **User → Preferences →
   Applications** for a user-scoped client)
   - Redirect URI: `https://fleet.example.com/auth/sso/callback/gitlab`
   - Scopes: `openid email profile`
   - "Confidential" ON.
2. Copy the application ID (`client_id`) and secret.

GitLab puts the user's groups into the `groups_direct` claim by
default and full-path groups in `groups`.

```yaml
- id: gitlab
  kind: oidc
  display_name: GitLab
  issuer: https://gitlab.example.com
  client_id: ${env:GITLAB_CLIENT_ID}
  client_secret: ${env:GITLAB_CLIENT_SECRET}
  redirect_uri: https://fleet.example.com/auth/sso/callback/gitlab
  scopes: ["openid", "email", "profile"]
  groups_claim: groups_direct
  role_mappings:
    "platform/fleet-admins": admin
    "platform/fleet-editors": editor
```

### Google Workspace

Google's id_token does not include groups by default. The simplest
mapping is by email domain — but the manager only supports **group**
claims for role mapping, so you have two options:

1. (Easiest) Use `cloud-identity` group claims by enabling the
   `https://www.googleapis.com/auth/admin.directory.group.readonly`
   scope on the OAuth client and emitting group memberships via
   `cloud-identity.groups` claim.
2. (Workaround) Use a Google-fronted IdP that emits the claim — e.g.
   put Keycloak / Auth0 in front of Google.

Once you have a groups claim:

```yaml
- id: google
  kind: oidc
  display_name: Google
  issuer: https://accounts.google.com
  client_id: ${env:GOOGLE_CLIENT_ID}
  client_secret: ${env:GOOGLE_CLIENT_SECRET}
  redirect_uri: https://fleet.example.com/auth/sso/callback/google
  scopes: ["openid", "email", "profile"]
  # Replace with whatever claim your Workspace exposes group
  # memberships under. Plain `groups` is rare on bare Workspace OIDC.
  groups_claim: groups
  role_mappings:
    "fleet-admins@example.com": admin
    "fleet-editors@example.com": editor
```

### Auth0

In Auth0 → Applications → Create Application → Regular Web Application:

- Allowed Callback URLs: `https://fleet.example.com/auth/sso/callback/auth0`
- Connections: enable whatever IdPs your users sign in through.

To emit groups on the id_token, add an Action on the Login flow:

```js
exports.onExecutePostLogin = async (event, api) => {
  const groups = (event.user.app_metadata?.fleet_groups ?? []);
  api.idToken.setCustomClaim("https://fleet/groups", groups);
};
```

```yaml
- id: auth0
  kind: oidc
  display_name: Auth0
  issuer: https://your-tenant.auth0.com/
  client_id: ${env:AUTH0_CLIENT_ID}
  client_secret: ${env:AUTH0_CLIENT_SECRET}
  redirect_uri: https://fleet.example.com/auth/sso/callback/auth0
  scopes: ["openid", "email", "profile"]
  groups_claim: "https://fleet/groups"   # custom-claim namespace from the Action above
  role_mappings:
    "fleet-admins": admin
    "fleet-editors": editor
```

## UI walkthrough

### Settings → Identity providers (`sso.read` to view, `sso.write` to edit)

- Each provider gets a card with a "managed via YAML" / "managed in
  UI" badge.
- **Test connection** runs a discovery + JWKS probe against the IdP
  and surfaces the `authorization_endpoint` / `token_endpoint` /
  `jwks_keys` — useful sanity check before asking a user to sign in.
- **Edit** opens a form with every field. For YAML-managed providers,
  saving creates a `source='ui'` overlay row that shadows the YAML
  config; you'll see the badge flip from "via YAML" to "in UI".
- **Delete** only works on `source='ui'` rows. YAML rows return a 409
  with a hint to edit the YAML file (we don't shadow-delete YAML
  rows because the next process restart would re-create them).
- **Group → Role mappings** is an editable list. Multiple mappings to
  the same group are unioned (a user in `/fleet-admins` can be both
  `admin` and `viewer` if you want).

### Settings → SSO Activity (`sso.read`)

Filtered view of three audit actions:

- `auth.sso.login` — successful sign-ins, with provider, jit_provisioned, and the role names that ended up applied.
- `auth.sso.rejected` — every reason an attempt was rejected; the on-call view.
- `auth.sso.role_sync` — only emitted when a sync **changed** a user's roles; metadata `{added, removed}` for diffing.

Toggle pills filter to one action at a time.

### Settings → Users (`users.read`; SSO actions need `sso.write`)

- Rows whose `oidc_issuer` is set get a `SSO · <provider>` badge with
  a tooltip explaining the role-sync behaviour. The provider display
  name is resolved from the registry; if it's been removed since the
  user was provisioned, the literal issuer URL is shown.
- **Filter pill** "SSO-managed only" hides every local-password user.
- **Row actions**:
  - "Link to SSO…" on a local-password user. Pick a provider, paste
    the IdP's `sub` claim, hit Link. Used to recover from a
    `email_collision_local_user` rejection.
  - "Unlink SSO" on an SSO-managed user. Reverts them to a local
    account; their roles are preserved but they have no usable
    password until an admin resets one.

## Failure-mode table

Every reason in the table emits an `auth.sso.rejected` audit row with
`metadata.reason` set to the code below. The reason code is also
appended to the login page URL as `?sso_error=<code>` so the UI
shows it inline — useful when relaying a screenshot from a user.

| Code | Meaning | Operator action |
| ---- | ------- | --------------- |
| `provider_not_found` | Callback URL referenced an unknown provider id. | Re-check the redirect URI registered with the IdP matches the provider id in YAML/DB. |
| `missing_state_cookie` | The browser didn't return the `fleet.sso_state` cookie — usually a 3rd-party-cookie or `SameSite` mismatch. | Make sure the manager is reachable on the same eTLD+1 the user originally hit. |
| `state_mismatch` | State / nonce / PKCE check failed. | Almost always a duplicate sign-in tab. Tell the user to close other tabs and retry. |
| `id_token_invalid` | Signature, issuer, audience, or expiry didn't validate against the IdP's JWKS. | Provider misconfigured (wrong issuer URL? client_id mismatch?). Run `Test connection` from the UI. |
| `missing_email_claim` | IdP didn't return an email. | Add `email` to the scopes; in some IdPs the email claim must be enabled per-application. |
| `no_groups_assigned` | None of the user's groups mapped to a fleet role. | Check the `groups_claim` path is correct and that at least one of the user's groups has a `role_mappings` entry. |
| `email_collision_local_user` | A local-password user already has this email (no `(issuer, subject)`). | Use **Settings → Users → Link to SSO…** to bind the existing local user. |
| `user_disabled` | The user row has `disabled=true`. | Re-enable the user (you'll usually want to first ask why they were disabled). |
| `callback_failed` | Catch-all for any other callback exception. | Inspect the audit row's metadata; usually a network blip talking to the IdP token endpoint. |

## Manual smoke test (Keycloak)

Quickest way to validate end-to-end:

```bash
# 1. Run Keycloak ephemerally
docker run --rm -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:24.0 start-dev

# 2. Realm setup (manual): create realm `fleet`; create client
#    `fleet-manager` (confidential, redirect URI
#    http://localhost:9090/auth/sso/callback/keycloak); add a group
#    `fleet-admins`; add a Group Membership mapper that emits a
#    `groups` claim; create a user, assign the group.

# 3. Configure the manager
cat > sso.yaml <<'EOF'
providers:
  - id: keycloak
    kind: oidc
    display_name: Keycloak
    issuer: http://localhost:8080/realms/fleet
    client_id: fleet-manager
    client_secret: ${env:KEYCLOAK_CLIENT_SECRET}
    redirect_uri: http://localhost:9090/auth/sso/callback/keycloak
    scopes: ["openid", "email", "profile", "groups"]
    groups_claim: groups
    role_mappings:
      "/fleet-admins": admin
EOF

KEYCLOAK_CLIENT_SECRET=... \
SSO_CONFIG_FILE=$PWD/sso.yaml \
ADMIN_TOKEN=devtoken \
DATABASE_URL=postgres://... \
node apps/fleet-manager/dist/server.js

# 4. Open http://localhost:9090/ui/login → click "Sign in with Keycloak"
```

## Migrating from an existing local-password fleet

There's nothing to migrate — local-password users keep working
unchanged. To onboard your team to SSO without flag-day:

1. Configure the IdP and add the YAML / UI provider.
2. For each existing local-password user, ask them to attempt SSO
   sign-in once. They'll get rejected with
   `email_collision_local_user`.
3. An admin opens **Settings → Users**, finds the user, and clicks
   "Link to SSO…" with the user's `sub` claim. (Look it up via your
   IdP admin console — for Keycloak it's the user's UUID; for GitLab
   it's the numeric user id.)
4. The user retries and signs in successfully. Their roles are now
   sourced from group claims.

When you're confident everyone has signed in successfully, you can
remove the `password_hash` column from individual users via the API
(setting it to `null` is currently not exposed via the UI by design —
admins should unlink rather than blank-password users).

## Security checklist (enforced by implementation)

- State + nonce + PKCE on every authorize (handled by `openid-client`).
- id_token validated against the IdP's JWKS, with `iss`, `aud`,
  `exp`, and `nonce` checks.
- `(issuer, subject)` is the canonical user key; `email` is metadata.
- `client_secret` is never logged; the API always returns it masked
  as `***` on read.
- Reject sign-ins where `users.disabled=true` even if the IdP allows.
- Last-active-admin lockout: if a role sync would strip admin from
  the only remaining active admin, the sync is aborted and an audit
  row is emitted; the user keeps their previous role set for that
  session.
- Session cookie reuses the existing signed `fleet.sid` cookie — no
  second cookie scheme.
- **SSRF guard on every outbound OIDC request.** Two layers:
  1. Pre-flight `assertSafeIssuerUrl` runs at YAML load and on
     `POST` / `PATCH /sso/providers`. The issuer URL must be `https://`
     and its hostname must not resolve to a private/loopback/multicast
     address. Misconfigurations fail fast with a clear error
     (`issuer_unsafe`, `code: private_address` etc.).
  2. A custom DNS lookup (`auth/sso/url-guard.ts`) is wired into
     `openid-client` via `custom.setHttpOptionsDefaults({ lookup })`
     so every TCP connect — discovery, JWKS, token exchange,
     userinfo, and any HTTP redirect target — re-checks the resolved
     IP. This catches DNS rebinding and 30x responses pointing at
     private hosts even though those URLs were never validated by us.
- **Local IdP escape hatch.** Set
  `FLEET_SSO_ALLOW_INSECURE_ISSUER=1` to disable both the HTTPS
  requirement and the private-address check for the running process.
  Use this for Keycloak in `docker-compose` where the issuer is
  `http://keycloak:8080/realms/...` on a private container network.
  Never set it in production.
