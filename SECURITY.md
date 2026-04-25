# Security Policy

## Supported Versions

Until the project reaches `1.0`, only the latest **minor** release
receives security fixes. Pre-`1.0` minor versions are treated as
breaking-change boundaries (`0.x` → `0.y`), and we do not back-port
patches across them.

| Version | Supported          |
| ------- | ------------------ |
| `0.x`   | latest minor only  |

After `1.0` we will publish a back-port window in this section.

## Reporting a Vulnerability

**Please do not open a public GitLab issue or GitHub issue for a
security report.** Use the private disclosure path so we can ship a
fix before the report becomes public.

You have two channels:

1. **GitLab confidential issue** *(preferred)* — open an issue on the
   GitLab project and tick **"This issue is confidential"** before
   submitting. Confidential issues are visible only to project
   maintainers.

   https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/issues/new

2. **Email** — the maintainers reachable at the address listed in
   [`MAINTAINERS.md`](MAINTAINERS.md). PGP welcome but not required.

Please include:

- A short description of the issue and its impact (auth bypass, RCE,
  cross-tenant leak, secret exposure, etc.).
- The affected component(s): `fleet-manager`, `fleet-agent`,
  `fleet-ui`, `fleetctl`, `terraform-provider-fleet`, `@fleet-oss/sdk`,
  the catalog, the proto surface, etc.
- A reproducer if you have one — minimum config, request transcript,
  or test case.
- Whether you've already disclosed this anywhere (other private
  reports, mailing lists, social media drafts, etc.).

We will acknowledge receipt within **3 business days** and aim to
respond with a triage decision within **7 business days**.

## Disclosure timeline

We follow coordinated disclosure:

1. Triage and confirm.
2. Develop a fix on a private branch and prepare a release.
3. Notify the reporter and agree on a coordinated public-disclosure
   date (typically the day the patch ships).
4. Cut a release, publish a CVE if applicable, and credit the reporter
   in the [`CHANGELOG`](CHANGELOG.md) (unless they prefer to remain
   anonymous).

For widely-deployed or "easy to weaponize" issues we may shorten the
window; for niche issues we may extend it on request.

## Threat model & built-in protections

The fleet manager is a self-hosted, single-tenant control plane. The
threat model assumes a **partially-trusted admin operator**, untrusted
network clients, and untrusted Alloy collectors. The protections below
are enforced in code; see `docs/auth.md` and `docs/sso.md` for the
operator-facing detail.

| Protection                              | Where                                             |
| --------------------------------------- | ------------------------------------------------- |
| Argon-equivalent password hashing       | bcryptjs cost factor 12 (`auth/passwords.ts`)     |
| Server-side sessions, signed cookies    | `httpOnly` + `signed` + `sameSite=lax` + `secure` |
| Timing-safe token comparison            | `auth/middleware.ts`, `remotecfg/routes.ts`       |
| Per-IP rate limit on `/auth/login`      | `@fastify/rate-limit`, 10 req / 15 min            |
| Per-account lockout                     | 5 consecutive failures → 15 min lock              |
| Strict CSP + `frame-ancestors 'none'`   | `@fastify/helmet`, `server.ts`                    |
| HSTS with `includeSubDomains`           | `@fastify/helmet`, `server.ts`                    |
| Pino redaction of auth headers + bodies | `server.ts` logger config                         |
| Audit-metadata secret deny-list         | `services/audit.ts` `sanitizeAuditMetadata`       |
| OIDC SSRF guard (pre-flight + runtime)  | `auth/sso/url-guard.ts`                           |
| Last-admin-lockout guard                | `routes/users.ts` PATCH/DELETE `/users/:id`       |
| Privilege containment on API tokens     | `auth/api-tokens.ts` (token roles ⊆ owner roles)  |
| Plaintext token returned exactly once   | `routes/tokens.ts` POST `/tokens`                 |

The OIDC SSRF guard deserves a callout: every outbound request from
`openid-client` (discovery, JWKS fetch, token exchange, userinfo) goes
through a custom DNS lookup that rejects RFC1918, loopback, link-local,
ULA, multicast, and CGNAT addresses. This catches both static
misconfiguration AND DNS-rebind / HTTP-redirect targets at TCP-connect
time. Operators running a private IdP (e.g. Keycloak in
docker-compose) can opt out per process with
`FLEET_SSO_ALLOW_INSECURE_ISSUER=1`.

## Out of scope

- Self-DoS by an authenticated administrator (e.g. you submit a
  pathologically large pipeline). The product is single-tenant by
  design and admins are trusted.
- Findings that require an attacker to already control the postgres
  database, the host filesystem, or the SSO IdP.
- Reports against the `examples/` directory (those are intentionally
  insecure stand-ins for local development).

## Hardening guidance

Operator-side checklists live in:

- [`docs/auth.md`](docs/auth.md) — RBAC, session, and token model
- [`docs/sso.md`](docs/sso.md) — OIDC SSO security checklist
- [`docs/deployment.md`](docs/deployment.md) — production deployment
  guidance

Issues that boil down to "the default `change-me-*` token is insecure"
will be politely closed with a pointer to those documents.
