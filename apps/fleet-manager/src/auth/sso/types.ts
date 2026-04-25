/**
 * SSO provider abstraction.
 *
 * Phase 2 ships only the OIDC implementation, but every routing /
 * registry / login-flow surface above this interface is shape-stable
 * so SAML can drop in later as a second `SsoProvider` without
 * touching the rest of the stack.
 *
 * The contract:
 *
 *   1. `startLogin` is invoked by GET /auth/sso/start/:id. The provider
 *      is responsible for setting whatever short-lived state cookie
 *      it needs (`fleet.sso_state`) and redirecting the browser to
 *      the IdP's authorization endpoint. It MUST own the redirect; the
 *      route handler stops touching `reply` after this returns.
 *
 *   2. `handleCallback` is invoked by GET /auth/sso/callback/:id. It
 *      reads + validates the state cookie, exchanges the auth code,
 *      and returns the canonical `SsoIdentity` for the route handler
 *      to JIT-provision / link / sign in. It throws SsoCallbackError
 *      with a stable `reason` code on every audited failure path so
 *      the caller can record `auth.sso.rejected` rows uniformly.
 *
 *   3. `testConnection` does a non-mutating discovery + JWKS fetch.
 *      Used by the admin "Test connection" button. Surfacing key
 *      counts catches the common "valid issuer URL but JWKS hosed"
 *      misconfiguration that the auth endpoint discovery would mask.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** Canonical user identity derived from a successful IdP callback. */
export interface SsoIdentity {
  /** Issuer URL — half of the natural key. Stored in `users.oidc_issuer`. */
  issuer: string;
  /** Subject (sub claim) — the other half. Stored in `users.oidc_subject`. */
  subject: string;
  /** REQUIRED. Used for collision detection against local users. */
  email: string;
  /** OPTIONAL profile name. Empty string means "no name claim". */
  name: string | null;
  /** Group / role claim values, already extracted via the configured claim path. */
  groups: string[];
}

/** Result shape returned by `SsoProvider.testConnection`. */
export interface TestConnectionResult {
  ok: boolean;
  /** Populated only when ok = false. Stable enough to render in the UI. */
  error?: string;
  /** Number of signing keys discovered in the IdP's JWKS, when fetchable. */
  jwks_keys?: number;
  /** Echoed metadata so the UI can show "discovered https://kc/.../auth". */
  authorization_endpoint?: string;
  token_endpoint?: string;
}

/**
 * Stable failure codes. Used both for HTTP error pages (UI shows a
 * recipe per code) and for `auth.sso.rejected` audit rows (auditors
 * can group by reason).
 *
 * Add a code here BEFORE adding a code path that returns it — the
 * docs/sso.md table cross-references this enum.
 */
export type SsoRejectionReason =
  | "missing_state_cookie"
  | "state_mismatch"
  | "id_token_invalid"
  | "missing_email_claim"
  | "no_groups_assigned"
  | "email_collision_local_user"
  | "user_disabled"
  | "provider_not_found"
  | "callback_failed";

export class SsoCallbackError extends Error {
  constructor(
    public readonly reason: SsoRejectionReason,
    public readonly metadata: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = "SsoCallbackError";
  }
}

/**
 * What the registry exposes for a configured provider. The `source`
 * field is informational only — the merge has already happened by the
 * time anything sees a `SsoProvider`.
 */
export interface SsoProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "oidc" | "saml";
  readonly source: "yaml" | "ui";

  startLogin(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  handleCallback(req: FastifyRequest): Promise<SsoIdentity>;
  testConnection(): Promise<TestConnectionResult>;
}
