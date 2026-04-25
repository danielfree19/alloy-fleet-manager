/**
 * Public SSO auth surface.
 *
 * Three endpoints, all unauthenticated by design (these ARE the
 * authentication path):
 *
 *   GET /auth/providers
 *     Lists configured providers. The login page reads this and
 *     renders one SSO button per row. Returns `[]` when SSO is
 *     disabled — keeping the UI's request shape uniform whether
 *     SSO is on or not.
 *
 *   GET /auth/sso/start/:id
 *     Kick off the OIDC flow with the named provider. The provider
 *     owns the redirect.
 *
 *   GET /auth/sso/callback/:id
 *     Handle the IdP redirect. On success: JIT-provision (if needed),
 *     sync roles, create a session, set `fleet.sid`, and redirect to
 *     the UI. On failure: audit + render a small error page.
 *
 * Sign-in policy (locked in with the plan):
 *   - JIT requires non-empty role mapping. Empty groups → REJECT
 *     with `no_groups_assigned`.
 *   - Email collision with a local password user (no `(issuer,
 *     subject)`) → REJECT with `email_collision_local_user`. Admin
 *     must explicitly link.
 *   - Disabled user → REJECT with `user_disabled`.
 *   - On every successful login: replace user's roles with the
 *     IdP-derived set (sync), audit `auth.sso.role_sync` if changed.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import type { ProviderRegistry } from "../auth/sso/registry.js";
import { SsoCallbackError, type SsoRejectionReason } from "../auth/sso/types.js";
import { SSO_STATE_COOKIE } from "../auth/sso/oidc.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
} from "../auth/sessions.js";
import {
  createOidcUser,
  findUserByEmailIncludingOidc,
  findUserByOidcSubject,
  listUserRoles,
  loadUserPermissions,
  syncUserRolesForOidc,
} from "../auth/users.js";
import { auditFieldsFromActor, recordAuditEvent } from "../services/audit.js";
import type { Actor } from "../auth/permissions.js";

export interface SsoRoutesDeps {
  config: AppConfig;
  db: DbPool;
  registry: ProviderRegistry;
}

export function registerSsoRoutes(deps: SsoRoutesDeps): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const { db, registry } = deps;

    /**
     * Public list. No auth required — the login page is itself
     * unauthenticated, and we explicitly do NOT leak anything
     * sensitive (no client_secret, no issuer URL, no scopes).
     */
    app.get("/auth/providers", async () => {
      return { providers: registry.listProviders() };
    });

    /**
     * Begin the OIDC flow. The provider owns the redirect; this
     * handler exits without touching `reply` after `startLogin`
     * returns (which itself called `reply.redirect`).
     */
    app.get(
      "/auth/sso/start/:id",
      {
        // SSO start triggers an outbound HTTP discovery to the IdP.
        // The same per-IP cap that protects /auth/login also applies
        // here so an attacker can't make the manager hammer an IdP
        // (or a victim host the manager has been pointed at).
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "15 minutes",
          },
        },
      },
      async (req, reply) => {
      const { id } = req.params as { id: string };
      const provider = registry.getProvider(id);
      if (!provider) {
        return reply.code(404).send({ error: "provider_not_found" });
      }
      try {
        await provider.startLogin(req, reply);
      } catch (err) {
        // Discovery failure / network blip on the IdP side. We don't
        // audit here — `auth.sso.rejected` is reserved for callbacks
        // that were validated against state, since the start path
        // is too easy to hit unintentionally.
        const message = err instanceof Error ? err.message : String(err);
        app.log.warn({ provider: id, err: message }, "sso.start failed");
        return reply.code(502).send({ error: "sso_unavailable", details: message });
      }
    });

    /**
     * Handle the IdP redirect. Long, but the structure is:
     *   1. Resolve provider; reject + audit if missing.
     *   2. Hand off to provider.handleCallback which returns an
     *      SsoIdentity OR throws SsoCallbackError.
     *   3. Find existing user by (issuer, subject); else email; else
     *      JIT-create.
     *   4. Map groups → roles; reject + audit if empty.
     *   5. Sync roles, create session, redirect to /ui.
     */
    app.get("/auth/sso/callback/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const provider = registry.getProvider(id);
      if (!provider) {
        await auditRejection(db, id, "provider_not_found", null, null, {});
        return renderRejection(reply, "provider_not_found");
      }

      let identity;
      try {
        identity = await provider.handleCallback(req);
      } catch (err) {
        const reason: SsoRejectionReason =
          err instanceof SsoCallbackError ? err.reason : "callback_failed";
        const meta =
          err instanceof SsoCallbackError
            ? err.metadata
            : { message: err instanceof Error ? err.message : String(err) };
        await auditRejection(db, id, reason, null, null, meta);
        // Always clear the state cookie — it's now spent.
        reply.clearCookie(SSO_STATE_COOKIE, { path: "/" });
        return renderRejection(reply, reason);
      }
      reply.clearCookie(SSO_STATE_COOKIE, { path: "/" });

      // ---- Resolve the user -----------------------------------------------
      const roleIds = registry.rolesForGroups(provider.id, identity.groups);
      if (roleIds.length === 0) {
        await auditRejection(
          db,
          id,
          "no_groups_assigned",
          identity.email,
          identity.subject,
          { groups: identity.groups },
        );
        return renderRejection(reply, "no_groups_assigned");
      }

      let user = await findUserByOidcSubject(db, identity.issuer, identity.subject);
      let jitProvisioned = false;
      if (!user) {
        // First-time SSO sign-in for this (issuer, subject). Check
        // for an email collision with a local user before JIT.
        const existing = await findUserByEmailIncludingOidc(db, identity.email);
        if (existing) {
          // The matching user must have the same (issuer, subject)
          // for this to be a success path. If they don't, the email
          // collides with a local-password user; reject.
          if (
            existing.oidc_issuer === identity.issuer &&
            existing.oidc_subject === identity.subject
          ) {
            user = existing;
          } else {
            await auditRejection(
              db,
              id,
              "email_collision_local_user",
              identity.email,
              identity.subject,
              { existing_user_id: existing.id },
            );
            return renderRejection(reply, "email_collision_local_user");
          }
        } else {
          user = await createOidcUser(db, {
            email: identity.email,
            name: identity.name,
            oidc_issuer: identity.issuer,
            oidc_subject: identity.subject,
            roleIds,
          });
          jitProvisioned = true;
        }
      }

      if (user.disabled) {
        await auditRejection(
          db,
          id,
          "user_disabled",
          user.email,
          identity.subject,
          { user_id: user.id },
        );
        return renderRejection(reply, "user_disabled");
      }

      // ---- Sync roles -----------------------------------------------------
      // Always run sync — even on JIT — for consistency. On JIT the
      // diff will report 0 changes since createOidcUser already
      // applied the same role set; we keep the call to centralize the
      // diff logic.
      const diff = await syncUserRolesForOidc(db, user.id, roleIds);

      const rolesAfter = await listUserRoles(db, user.id);
      const perms = await loadUserPermissions(db, user.id);

      // ---- Audit the success path ----------------------------------------
      const loginActor: Actor = {
        kind: "user",
        userId: user.id,
        email: user.email,
        name: user.name,
        apiTokenId: null,
        permissions: perms,
      };
      await recordAuditEvent(db, {
        ...auditFieldsFromActor(loginActor),
        action: "auth.sso.login",
        target_kind: "user",
        target_id: user.id,
        target_name: user.email,
        metadata: {
          provider: provider.id,
          issuer: identity.issuer,
          subject: identity.subject,
          jit_provisioned: jitProvisioned,
          role_names: rolesAfter.map((r) => r.name),
        },
      });

      if (diff.added.length > 0 || diff.removed.length > 0) {
        await recordAuditEvent(db, {
          ...auditFieldsFromActor(loginActor),
          action: "auth.sso.role_sync",
          target_kind: "user",
          target_id: user.id,
          target_name: user.email,
          metadata: {
            provider: provider.id,
            added: diff.added,
            removed: diff.removed,
          },
        });
      }

      // Also write a regular `auth.login` row so existing /audit
      // queries that filter by action='auth.login' still see SSO
      // sign-ins. Two rows per login is intentional — the SDK type
      // documents it ("These are emitted in addition to the regular
      // `auth.login` row").
      await recordAuditEvent(db, {
        ...auditFieldsFromActor(loginActor),
        action: "auth.login",
        target_kind: "user",
        target_id: user.id,
        target_name: user.email,
        metadata: {
          via: "sso",
          provider: provider.id,
          ip: req.ip,
        },
      });

      // ---- Create the session + redirect ---------------------------------
      const session = await createSession(db, user.id, {
        user_agent:
          typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"]
            : null,
        ip: req.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.protocol === "https",
        path: "/",
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        signed: true,
      });

      // The state cookie's `return_to` was preserved by the provider
      // when minted; we don't have it here cleanly anymore (the
      // provider already cleared it). Defaults to /ui/.
      return reply.redirect("/ui/");
    });
  };
}

/**
 * Audit + render. The reject responses are intentionally brief —
 * a malicious caller probing for "is there a fleet-admins group?"
 * can correlate via /audit anyway, so we don't try to hide much.
 */
async function auditRejection(
  db: DbPool,
  providerId: string,
  reason: SsoRejectionReason,
  email: string | null,
  subject: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  // No actor — the caller is unauthenticated by definition. We
  // populate `actor: 'sso:unauth'` so the audit list still shows
  // something meaningful.
  await recordAuditEvent(db, {
    actor: "sso:unauth",
    actor_kind: null,
    actor_user_id: null,
    actor_email: email,
    actor_token_id: null,
    action: "auth.sso.rejected",
    target_kind: "sso_provider",
    target_id: null,
    target_name: providerId,
    metadata: {
      reason,
      provider: providerId,
      subject,
      email,
      ...metadata,
    },
  });
}

/**
 * Render a small text/html page on failure. Operators can dig into
 * the audit log for details; we deliberately don't echo the IdP's
 * raw error message to the browser.
 */
function renderRejection(
  reply: import("fastify").FastifyReply,
  reason: SsoRejectionReason,
): import("fastify").FastifyReply {
  const messages: Record<SsoRejectionReason, string> = {
    missing_state_cookie:
      "We couldn't verify the sign-in state. Try again from the login page.",
    state_mismatch:
      "Sign-in state didn't match. Make sure you only have one sign-in tab open and try again.",
    id_token_invalid:
      "The identity provider returned an invalid token. Contact your administrator.",
    missing_email_claim:
      "Your identity provider didn't include an email address. Ask your admin to enable the email scope.",
    no_groups_assigned:
      "Your account isn't a member of any group that's mapped to a role on this fleet. Contact your administrator.",
    email_collision_local_user:
      "An account with this email already exists with a password. An administrator must link your SSO identity before you can sign in.",
    user_disabled:
      "Your account has been disabled. Contact your administrator.",
    provider_not_found: "Unknown identity provider.",
    callback_failed: "Sign-in failed. Try again.",
  };
  const message = messages[reason] ?? "Sign-in failed.";
  // Tiny HTML body. Living without a templating engine here keeps
  // this page reachable even if the static UI bundle is missing.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1f2937; }
h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
p  { line-height: 1.5; }
code { background: #f3f4f6; padding: 0.125rem 0.375rem; border-radius: 0.25rem; }
a  { color: #2563eb; }
</style></head>
<body>
<h1>Sign-in failed</h1>
<p>${escapeHtml(message)}</p>
<p style="font-size: 0.85rem; color: #6b7280;">
  Reason code: <code>${escapeHtml(reason)}</code>
</p>
<p><a href="/ui/login?sso_error=${escapeHtml(reason)}">Back to the login page</a></p>
</body></html>`;
  return reply.code(401).type("text/html; charset=utf-8").send(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
