/**
 * OIDC provider implementation.
 *
 * Wraps `openid-client` v5 to satisfy the `SsoProvider` contract.
 * Notable design choices:
 *
 *   - Discovery is cached PER provider instance. The registry rebuilds
 *     the instance whenever the provider config changes (in YAML or
 *     in the DB), which naturally invalidates the cache.
 *
 *   - The "callback state" payload (state token, nonce, PKCE verifier,
 *     return-to path) is stored in a SHORT-LIVED, SIGNED cookie named
 *     `fleet.sso_state`. We don't put it in PG because that would mean
 *     a write on every login attempt — auth flows are noisy when an
 *     IdP misbehaves and we don't want each redirect-loop iteration
 *     to be a DB round trip. Cookie size is well under 4KB.
 *
 *   - `secure: req.protocol === 'https'` matches the existing session
 *     cookie behavior so a developer running HTTP locally still gets
 *     a working login. In production behind TLS this flips to `secure`
 *     automatically.
 *
 *   - We DELIBERATELY do not log `client_secret` or any token bodies.
 *     The pino serializer in `index.ts` enforces this for nested
 *     fields; here we just don't emit them.
 *
 * Group claim extraction: the `groups_claim` config string is
 * dot-separated, so an Auth0-style `https://example.com/groups`
 * claim can be configured as that exact string and the dotted path
 * "user.groups" works for nested envelopes.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Issuer, custom, generators, type Client, type TokenSet } from "openid-client";
import type {
  SsoIdentity,
  SsoProvider,
  TestConnectionResult,
} from "./types.js";
import { SsoCallbackError } from "./types.js";
import { ssrfSafeLookup } from "./url-guard.js";

// Inject the SSRF-safe DNS lookup into openid-client's outbound HTTP
// stack. Applies process-wide to every Issuer.discover, JWKS fetch,
// token exchange, and userinfo call. Defense-in-depth alongside the
// pre-flight `assertSafeIssuerUrl` check at config write time.
custom.setHttpOptionsDefaults({ lookup: ssrfSafeLookup });

/**
 * Cookie name carrying the per-attempt state. Short TTL (10m) — long
 * enough to absorb network blips on the IdP, short enough to not
 * accumulate. Signed via fastify-cookie so a tampered state value is
 * rejected as if it were missing.
 */
export const SSO_STATE_COOKIE = "fleet.sso_state";
const SSO_STATE_TTL_SECONDS = 10 * 60;

/**
 * Public, route-friendly view of a provider's effective config.
 * The registry reads YAML + DB and produces this; OidcProvider
 * consumes it.
 */
export interface OidcProviderConfig {
  id: string;
  display_name: string;
  source: "yaml" | "ui";
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string[];
  groups_claim: string;
}

interface StateCookiePayload {
  /** OAuth `state` parameter — verified against the callback. */
  state: string;
  /** OIDC `nonce` claim — verified inside the id_token. */
  nonce: string;
  /** PKCE code_verifier we used to derive code_challenge. */
  code_verifier: string;
  /** Optional UI path to redirect to after sign-in succeeds. */
  return_to: string | null;
}

export class OidcProvider implements SsoProvider {
  readonly kind = "oidc" as const;

  /**
   * Lazily-resolved openid-client. Discovery is one HTTP fetch to the
   * IdP's `/.well-known/openid-configuration`; we cache the resulting
   * Client object and re-create only when the config object passed to
   * the constructor changes (handled by the registry).
   */
  private clientPromise: Promise<Client> | null = null;

  constructor(private readonly cfg: OidcProviderConfig) {}

  get id(): string {
    return this.cfg.id;
  }
  get displayName(): string {
    return this.cfg.display_name;
  }
  get source(): "yaml" | "ui" {
    return this.cfg.source;
  }

  private async client(): Promise<Client> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const issuer = await Issuer.discover(this.cfg.issuer);
        return new issuer.Client({
          client_id: this.cfg.client_id,
          client_secret: this.cfg.client_secret,
          redirect_uris: [this.cfg.redirect_uri],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        });
      })();
    }
    return this.clientPromise;
  }

  async startLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const client = await this.client();

    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();

    const returnTo = readReturnToParam(req);
    const payload: StateCookiePayload = {
      state,
      nonce,
      code_verifier,
      return_to: returnTo,
    };

    reply.setCookie(SSO_STATE_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      sameSite: "lax",
      secure: req.protocol === "https",
      path: "/",
      maxAge: SSO_STATE_TTL_SECONDS,
      signed: true,
    });

    const authUrl = client.authorizationUrl({
      scope: this.cfg.scopes.join(" "),
      state,
      nonce,
      code_challenge,
      code_challenge_method: "S256",
    });
    reply.redirect(authUrl);
  }

  async handleCallback(req: FastifyRequest): Promise<SsoIdentity> {
    const client = await this.client();

    // Pull + verify the state cookie BEFORE consulting the IdP. If the
    // cookie is missing/forged we don't even try the token exchange.
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const raw = cookies?.[SSO_STATE_COOKIE];
    if (!raw) {
      throw new SsoCallbackError("missing_state_cookie");
    }
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      throw new SsoCallbackError("missing_state_cookie", { reason: "unsigned_invalid" });
    }
    let payload: StateCookiePayload;
    try {
      payload = JSON.parse(unsigned.value) as StateCookiePayload;
    } catch {
      throw new SsoCallbackError("missing_state_cookie", { reason: "malformed_payload" });
    }

    const params = client.callbackParams(req.raw);

    let tokenSet: TokenSet;
    try {
      tokenSet = await client.callback(this.cfg.redirect_uri, params, {
        state: payload.state,
        nonce: payload.nonce,
        code_verifier: payload.code_verifier,
      });
    } catch (err) {
      // openid-client throws on every auth failure: state mismatch,
      // bad nonce, expired id_token, signature mismatch. We bucket
      // them under one reason and stash the message for forensics.
      const message = err instanceof Error ? err.message : String(err);
      // state_mismatch is common enough and important enough to log
      // discretely — auditors care which IdP attempts are MITM-y vs
      // which are just stale browser tabs.
      const reason =
        /state mismatch/i.test(message) ? "state_mismatch" : "id_token_invalid";
      throw new SsoCallbackError(reason, { message });
    }

    // Pull claims from id_token; merge userinfo if needed for groups.
    let claims = tokenSet.claims() as Record<string, unknown>;
    const groupsFromToken = extractClaimByPath(claims, this.cfg.groups_claim);
    if (
      (groupsFromToken === undefined || groupsFromToken === null) &&
      tokenSet.access_token
    ) {
      // Some IdPs (Auth0 default, Keycloak with restricted id_token
      // scopes) ship groups only via /userinfo. Fall back transparently.
      try {
        const userinfo = (await client.userinfo(tokenSet.access_token)) as Record<
          string,
          unknown
        >;
        claims = { ...claims, ...userinfo };
      } catch {
        // Userinfo fetch failures are non-fatal here — we'll surface
        // the eventual no_groups_assigned rejection if the token
        // truly carries no groups.
      }
    }

    const subject = typeof claims.sub === "string" ? claims.sub : null;
    const email = typeof claims.email === "string" ? claims.email : null;
    const name =
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.preferred_username === "string"
          ? (claims.preferred_username as string)
          : null;

    if (!subject) {
      throw new SsoCallbackError("id_token_invalid", { reason: "missing_sub_claim" });
    }
    if (!email) {
      throw new SsoCallbackError("missing_email_claim");
    }

    const groups = normalizeGroupsClaim(extractClaimByPath(claims, this.cfg.groups_claim));

    return {
      issuer: this.cfg.issuer,
      subject,
      email,
      name,
      groups,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const issuer = await Issuer.discover(this.cfg.issuer);
      const meta = issuer.metadata as Record<string, unknown>;

      // Issuer.keystore() resolves to a JSON Web Key Set instance with
      // a `.toJWKS()` shape we can introspect for key count. Reach for
      // it via a try/catch in case the issuer doesn't expose JWKS
      // (very rare in practice).
      let jwksKeys = 0;
      try {
        // The internal `keystore()` call discovers + fetches JWKS.
        const ks = await (issuer as unknown as { keystore: () => Promise<{ all: () => unknown[] }> })
          .keystore();
        jwksKeys = ks.all().length;
      } catch {
        // Tolerate; the discovery succeeding is the meaningful signal.
      }

      return {
        ok: true,
        jwks_keys: jwksKeys,
        authorization_endpoint:
          typeof meta.authorization_endpoint === "string"
            ? (meta.authorization_endpoint as string)
            : undefined,
        token_endpoint:
          typeof meta.token_endpoint === "string"
            ? (meta.token_endpoint as string)
            : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Drill into a claims object using a dotted path. Used to read the
 * groups claim from configurable locations:
 *
 *   "groups"                            -> claims.groups
 *   "https://example.com/groups"        -> claims["https://example.com/groups"]
 *   "user.profile.groups"               -> claims.user.profile.groups
 *
 * The first hit wins so an Auth0-style namespaced claim (with literal
 * dots in the key) takes precedence over a coincidentally nested
 * lookup.
 */
function extractClaimByPath(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  const parts = path.split(".");
  let current: unknown = claims;
  for (const p of parts) {
    if (current && typeof current === "object" && p in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Normalize whatever the IdP sent into a string[] of group values.
 * Keycloak/GitLab send arrays. Some shops send a comma- or
 * space-separated string. Anything else (including absent) becomes
 * `[]` and the caller will reject with `no_groups_assigned`.
 */
function normalizeGroupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function readReturnToParam(req: FastifyRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.return_to;
  if (typeof raw !== "string") return null;
  // Open-redirect guard — same rules as the UI's `?next=` param.
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw === "/login" || raw.startsWith("/login?")) return null;
  return raw;
}
