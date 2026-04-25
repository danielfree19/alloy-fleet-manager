# Testing the new auth system

End-to-end smoke test for the Phase 1 identity stack: login, sessions,
API tokens, RBAC, audit. About 10 minutes start to finish.

## 0. One-time setup

Make sure `.env` has the bootstrap vars (already in `.env.example`):

```env
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=changeme-on-first-login
```

Reset the database so the new identity migration runs cleanly:

```bash
podman compose down -v   # or: docker compose down -v
podman compose up -d postgres
npm run migrate          # applies 1700000000003_identity.sql + seeds roles
```

Start the manager and UI in two terminals:

```bash
# terminal 1
npm run dev:manager
# terminal 2
npm run dev:ui
```

The first manager log line you want to see:

```
INFO  bootstrapped initial admin user  email=admin@example.com
```

If you see `WARN no users exist and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set`,
your env vars didn't reach the process. Fix and restart.

## 1. UI login

1. Open `http://localhost:5173`.
2. You should see the new login screen with two tabs: **Sign in**
   (default) and **Use a token** (fallback).
3. Sign in as `admin@example.com / changeme-on-first-login`.
4. The sidebar should show:
   - your email + the `admin` role badge,
   - all nav items (Pipelines, Collectors, Catalog, Audit log, Settings),
   - a Sign out button.

Open DevTools → Application → Cookies → `http://localhost:5173`. There
should be a `fleet.sid` cookie, HttpOnly, signed.

## 2. Self-service password change

1. `Settings → Account` → change password (must be ≥ 8 chars).
2. Sign out, sign back in with the new password.
3. The old password must now fail with `invalid_credentials`.

## 3. Create a non-admin user (RBAC test)

1. `Settings → Users` → **New user**:
   - email `viewer@example.com`
   - password `viewer-test-1`
   - role: `viewer`
2. Sign out, sign in as `viewer@example.com`.
3. The sidebar should now hide:
   - Settings → Users (no `users.read`)
   - Settings → Roles (no `users.read`)
4. The Pipelines page should hide the **+ New pipeline** button (no
   `pipelines.create`).
5. The Audit log page is still visible (`viewer` has `audit.read`).
6. Sign out and sign back in as admin.

## 4. Custom role with the new pipelines.create / pipelines.update split

1. `Settings → Roles` → **New role**:
   - name `pipeline-maintainer`
   - permissions: `pipelines.read`, `pipelines.update`
   - **NOT** `pipelines.create`, **NOT** `pipelines.delete`
2. Create a user `editor-only@example.com` with that role.
3. Sign in as them. The Pipelines page should show the list and edit
   buttons but no "New pipeline" button. Editing an existing pipeline
   should succeed; creating one should be impossible from the UI.

## 5. API token end-to-end

Sign in as admin.

1. `Settings → API tokens` → **New token**:
   - name `fleetctl-laptop`
   - role: `viewer`
   - expires: leave empty
2. After creation a banner shows the token **once**:
   `fmt_<prefix>_<secret>`. Copy it.
3. Test it from the CLI:

   ```bash
   TOKEN='fmt_xxx_yyy'   # the value you just copied

   # Should return the resolved actor (kind=api_token, permissions=[catalog.read, ...])
   curl -s http://localhost:9090/auth/me \
     -H "Authorization: Bearer $TOKEN" | jq

   # Should succeed (viewer role has pipelines.read)
   curl -s http://localhost:9090/pipelines \
     -H "Authorization: Bearer $TOKEN" | jq '.pipelines | length'

   # Should 403 (viewer has no pipelines.create)
   curl -i -X POST http://localhost:9090/pipelines \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"name":"nope","enabled":true,"selector":{},"content":""}'
   ```

   Last call must return `403 forbidden` with body `{"error":"forbidden","permission":"pipelines.create"}`.

4. Revoke it from the UI; the same `curl /auth/me` should now 401.

## 6. Privilege containment on token mint

As the `viewer@example.com` user from step 3 (they only have `viewer`):

1. `Settings → API tokens` → **New token** with role `admin`.
2. The server must reject this with `role_not_held_by_creator`. The
   UI should surface the error toast. Without this rule a viewer
   could mint themselves an admin token.

## 7. Session invalidation on disable / password reset

1. As admin, while `viewer@example.com` is signed in in another
   browser/incognito window, go to `Settings → Users` → edit them →
   **Disabled = true** → save.
2. The viewer's next request (any nav click) should bounce them back
   to the login screen — their `fleet.sid` row is gone.
3. Re-enable them, then click **Reset password** in the admin UI.
4. Sign them in with the new password; the old password no longer works.

## 8. Audit log records actor identity

`Settings` → **Audit log** (or as admin, `curl
http://localhost:9090/audit?limit=10 -b fleet.sid=...`).

For each event you should see one of:

- `actor_kind=user`, `actor_email=<email>`, `actor_user_id=<uuid>`
- `actor_kind=api_token`, `actor_token_id=<uuid>`, `actor_email=<owner>`
- `actor_kind=env_token` for any `ADMIN_TOKEN`-bearer call

The legacy `actor` string column is still populated (`user:<email>` /
`api-token:<id>` / `admin-token:env`) so old audit consumers keep working.

## 9. ADMIN_TOKEN break-glass still works

```bash
curl -s http://localhost:9090/auth/me \
  -H "Authorization: Bearer change-me-admin-token" | jq
```

Should return:

```json
{
  "actor": { "kind": "env_token", "name": "admin (env token)" },
  "permissions": [ /* all 12 */ ]
}
```

This is the recovery path if you've locked yourself out of the UI.

## 10b. Per-Alloy `agent` token for remotecfg

Verifies that a `fmt_…` token with the built-in `agent` role can call
the remotecfg RPCs in place of the shared `AGENT_BEARER_TOKEN`.

```bash
# 1. Mint an agent token (UI: Settings → API tokens → New token,
#    role: agent). Copy the secret. Or via API:
ADMIN="change-me-admin-token"
AGENT_ROLE_ID=$(curl -s -H "Authorization: Bearer $ADMIN" \
  http://localhost:9090/roles \
  | jq -r '.roles[] | select(.name=="agent") | .id')

# Create a non-admin user "edge-host-01" and give them ONLY the
# agent role, then mint a token.
USER_ID=$(curl -s -X POST http://localhost:9090/users \
  -H "Authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d "{\"email\":\"edge-host-01@fleet.local\",\"role_ids\":[\"$AGENT_ROLE_ID\"]}" \
  | jq -r .id)

TOKEN=$(curl -s -X POST http://localhost:9090/tokens \
  -H "Authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d "{\"name\":\"edge-host-01\",\"user_id\":\"$USER_ID\",\"role_ids\":[\"$AGENT_ROLE_ID\"]}" \
  | jq -r .token)

# 2. Use it against remotecfg.
curl -s -X POST http://localhost:9090/collector.v1.CollectorService/GetConfig \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"edge-host-01","local_attributes":{"env":"dev","role":"edge"},"hash":""}' \
  | jq

# 3. Confirm the agent CANNOT do anything else.
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:9090/pipelines
# → 403
```

Expected:
- step 2 returns the assembled config (or `notModified: true`),
- step 3 returns `403` because the agent role only has `collectors.poll`,
- in `Settings → API tokens` the token's "last used" updates after step 2,
- the audit log does NOT contain a row for the poll (this is intentional —
  see `docs/auth.md` §"Audit log integration").

## 10. CORS + cookie sanity check

In the browser console on `http://localhost:5173`:

```js
await fetch('http://localhost:9090/auth/me', { credentials: 'include' })
  .then(r => r.json())
```

Should return your actor. If you see a CORS error, the manager isn't
running with `credentials: true` — check `apps/fleet-manager/src/server.ts`.

---

## Quick failure-mode reference

| Symptom                                              | Cause                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `WARN no users exist and BOOTSTRAP_… not set`        | Bootstrap env vars not exported into the manager process.            |
| Login returns 200 but UI loops back to login screen  | Cookie not being sent. Confirm `fleet-ui` calls go through `apiFetch` (which sets `credentials: include`). |
| `403 forbidden permission=...` after a UI action     | Working as intended — your role lacks that permission. Use `Settings → Roles` to inspect. |
| `cannot_delete_self` on DELETE /users/:id            | Working as intended — log in as a different admin first.             |
| API token creation works for admin but fails for non-admins with the same role | Working as intended — you're hitting privilege containment. The creator must hold the role they're trying to attach. |
