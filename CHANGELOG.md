# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are grouped into:

- **Added** — new features
- **Changed** — changes to existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — features removed in this release
- **Fixed** — bug fixes
- **Security** — vulnerability fixes (also linked from `SECURITY.md`)

## [Unreleased]

## [0.1.0] — 2026-04-25

First public open-source release. Everything previously listed under
`Unreleased` ships here.

### Added

- **Open-source release plumbing.** Apache-2.0 license, NOTICE,
  CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / MAINTAINERS, GitLab CI
  pipeline (`.gitlab-ci.yml`), GoReleaser configs for the Terraform
  provider and `fleetctl`, npm publish wiring for `@fleet-oss/sdk`,
  multi-arch Docker image build for `fleet-manager`, and an automated
  GitHub mirror push from GitLab CI. See [`docs/ci-cd.md`](docs/ci-cd.md)
  and [`docs/release.md`](docs/release.md).
- **First test harness.** `vitest` is now wired into
  `apps/fleet-manager` (`npm run test -w apps/fleet-manager`). Initial
  pure-function coverage on the SSRF guard, the audit-metadata
  sanitizer, and the lockout state helpers; DB-touching paths remain
  exercised via `scripts/e2e-terraform.sh`.

### Security

- **OIDC SSRF guard.** Every outbound request from `openid-client`
  (discovery, JWKS, token exchange, userinfo) now passes through a
  custom DNS lookup that rejects RFC1918, loopback, link-local, ULA,
  multicast, CGNAT, and other reserved ranges — catching both static
  misconfiguration and DNS-rebind / HTTP-redirect targets at TCP
  connect time. Pre-flight `assertSafeIssuerUrl` is also enforced at
  YAML config load and on `POST` / `PATCH` `/sso/providers`. Operators
  can opt out per-process with `FLEET_SSO_ALLOW_INSECURE_ISSUER=1`
  (typical for Keycloak in `docker-compose`). See
  [`docs/sso.md`](docs/sso.md).
- **Login brute-force protection.** Two new layers on `/auth/login`:
  per-IP rate limit (`@fastify/rate-limit`, 10 attempts / 15 min) and
  per-account lockout (5 consecutive failures → 15 min lock,
  `auth.login.locked` audit event). Admins clear locks via `PATCH
  /users/:id` with `{ "unlock": true }` (`user.unlock` audit event);
  see [`docs/auth.md`](docs/auth.md). Migration
  `1700000000006_login_lockout.sql` adds `users.failed_login_count`
  and `users.locked_until`. bcrypt still runs on locked-account
  attempts so response time can't be used to fingerprint lock state.
- **HTTP security headers.** `@fastify/helmet` is now registered
  globally with a strict CSP (`default-src 'self'`, `frame-ancestors
  'none'`, `object-src 'none'`), HSTS (1 year, `includeSubDomains`),
  `Referrer-Policy: no-referrer`, and `X-Content-Type-Options:
  nosniff`. Defends the admin UI against clickjacking and an XSS
  cookie-jar pivot.
- **Pino log redaction.** Auth headers, session/cookie headers, and
  the well-known body fields (`password`, `current_password`,
  `new_password`, `client_secret`, `token`, `*.password_hash`,
  `*.token_hash`) are stripped from request/response logs.
- **Audit-metadata secret deny-list.** `recordAuditEvent` now refuses
  to persist an audit row whose `metadata` contains a key matching
  `password`, `current_password`, `new_password`, `password_hash`,
  `client_secret`, `secret`, `token`, `token_hash`, `api_key`,
  `api_secret`, or `private_key` — throwing in dev/test and replacing
  with `"[redacted]"` in production. Locks the no-secrets-in-audit
  invariant in for future contributors.

### Inherited from the pre-release development snapshot

- `fleet-manager` Fastify API with the upstream-compatible
  `collector.v1.CollectorService` Connect RPC and a legacy REST
  surface.
- `fleet-ui` admin SPA served from `/ui/`.
- `fleet-agent` legacy Node.js pull-mode agent (preserved, not the
  primary path).
- `fleetctl` Go CLI companion.
- `terraform-provider-fleet` native Terraform provider with
  `fleet_pipeline`, `fleet_collector_role`, etc.
- `@fleet-oss/sdk` TypeScript client for Node and the browser.
- Identity, RBAC, sessions, API tokens, audit log.
- OIDC SSO — multi-IdP, hybrid YAML+DB config, JIT provisioning,
  per-login role sync, Settings UI for IdP management and SSO
  activity.
- Template catalog under `catalog/templates.json`.
- 0-to-100 e2e test driver at `scripts/e2e-terraform.sh`.

[Unreleased]: https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/compare/v0.1.0...HEAD
[0.1.0]: https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/tags/v0.1.0
