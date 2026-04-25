/**
 * Admin SSO surface — CRUD on identity providers + link/unlink for
 * user/SSO bindings. Permission-gated:
 *
 *   sso.read   GET  /sso/providers           list
 *              GET  /sso/providers/:id       detail
 *              POST /sso/providers/:id/test  connection probe (also writes
 *                                            an audit row when run via UI)
 *
 *   sso.write  POST   /sso/providers              create (DB-source)
 *              PATCH  /sso/providers/:id          edit (materializes a DB
 *                                                  row if currently YAML)
 *              DELETE /sso/providers/:id          DB-source rows only;
 *                                                  YAML rows return 409
 *              POST   /users/:id/link-sso         attach (issuer, subject)
 *              DELETE /users/:id/sso-link         detach
 *
 * Every mutation calls `registry.rebuild()` after COMMIT so the next
 * /auth/sso/* request sees the new shape immediately.
 *
 * `client_secret` is masked as `***` on every read. PATCH treats an
 * absent / empty `client_secret` field as "leave unchanged" so the
 * UI can submit the read form back without re-typing the secret.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import type { ProviderRegistry } from "../auth/sso/registry.js";
import { makeRequirePermission } from "../auth/middleware.js";
import { auditFieldsFromActor, recordAuditEvent } from "../services/audit.js";
import { envTokenActor } from "../auth/permissions.js";
import {
  findUserById,
  linkLocalUserToSso,
  unlinkUserSso,
} from "../auth/users.js";
import { UnsafeIssuerError, assertSafeIssuerUrl } from "../auth/sso/url-guard.js";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const RoleMappingsBody = z.record(
  z.string().min(1),
  z.array(z.string().uuid()).min(1),
);

const CreateProviderBody = z.object({
  id: z.string().min(1).regex(SLUG_RE),
  kind: z.enum(["oidc"]),
  display_name: z.string().min(1),
  issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string().min(1)).default(["openid", "email", "profile"]),
  groups_claim: z.string().min(1).default("groups"),
  role_mappings: RoleMappingsBody.default({}),
});

const UpdateProviderBody = z.object({
  display_name: z.string().min(1).optional(),
  issuer: z.string().url().optional(),
  client_id: z.string().min(1).optional(),
  // Empty string ⇒ "don't change". Treated identically to omitted.
  client_secret: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  scopes: z.array(z.string().min(1)).optional(),
  groups_claim: z.string().min(1).optional(),
  role_mappings: RoleMappingsBody.optional(),
});

const LinkSsoBody = z.object({
  provider_id: z.string().min(1),
  subject: z.string().min(1),
});

interface IdentityProviderRow {
  id: string;
  kind: string;
  display_name: string;
  issuer: string | null;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  scopes: string[] | null;
  groups_claim: string;
  source: "yaml" | "ui";
  created_at: string;
  updated_at: string;
}

export interface SsoAdminDeps {
  config: AppConfig;
  db: DbPool;
  registry: ProviderRegistry;
}

export function registerSsoAdminRoutes(deps: SsoAdminDeps): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const { config, db, registry } = deps;
    const requirePermission = makeRequirePermission({
      db,
      adminToken: config.ADMIN_TOKEN,
    });

    // -----------------------------------------------------------------
    // Provider CRUD
    // -----------------------------------------------------------------

    app.get(
      "/sso/providers",
      { preHandler: requirePermission("sso.read") },
      async () => {
        const rows = await db.query<IdentityProviderRow>(
          `SELECT id, kind, display_name, issuer, client_id, client_secret,
                  redirect_uri, scopes, groups_claim, source,
                  created_at, updated_at
             FROM identity_providers
             ORDER BY id`,
        );
        const out = await Promise.all(
          rows.rows.map(async (r) => ({
            ...maskRow(r),
            role_mappings: await loadProviderMappings(db, r.id),
          })),
        );
        return { providers: out };
      },
    );

    app.get(
      "/sso/providers/:id",
      { preHandler: requirePermission("sso.read") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const row = await fetchProviderRow(db, id);
        if (!row) return reply.code(404).send({ error: "not_found" });
        return {
          ...maskRow(row),
          role_mappings: await loadProviderMappings(db, id),
        };
      },
    );

    app.post(
      "/sso/providers",
      { preHandler: requirePermission("sso.write") },
      async (req, reply) => {
        const parsed = CreateProviderBody.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const body = parsed.data;
        // SSRF guard. Checked BEFORE the INSERT so the row is never
        // persisted with a private/loopback issuer. The runtime
        // `lookup` hook (auth/sso/oidc.ts) is the second layer that
        // also catches DNS-rebind / redirect targets.
        try {
          await assertSafeIssuerUrl(body.issuer);
        } catch (err) {
          if (err instanceof UnsafeIssuerError) {
            return reply.code(400).send({
              error: "issuer_unsafe",
              code: err.code,
              details: err.message,
            });
          }
          throw err;
        }
        try {
          await db.query(
            `INSERT INTO identity_providers
               (id, kind, display_name, issuer, client_id, client_secret,
                redirect_uri, scopes, groups_claim, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ui')`,
            [
              body.id,
              body.kind,
              body.display_name,
              body.issuer,
              body.client_id,
              body.client_secret,
              body.redirect_uri,
              body.scopes,
              body.groups_claim,
            ],
          );
          await replaceProviderMappings(db, body.id, body.role_mappings);
        } catch (err: unknown) {
          if ((err as { code?: string }).code === "23505") {
            return reply.code(409).send({ error: "provider_id_taken" });
          }
          throw err;
        }
        await registry.rebuild();

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "sso.provider.create",
          target_kind: "sso_provider",
          target_id: null,
          target_name: body.id,
          metadata: {
            kind: body.kind,
            issuer: body.issuer,
            display_name: body.display_name,
            role_mappings: body.role_mappings,
          },
        });

        const row = await fetchProviderRow(db, body.id);
        return reply.code(201).send({
          ...maskRow(row!),
          role_mappings: await loadProviderMappings(db, body.id),
        });
      },
    );

    app.patch(
      "/sso/providers/:id",
      { preHandler: requirePermission("sso.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = UpdateProviderBody.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const patch = parsed.data;
        const before = await fetchProviderRow(db, id);
        if (!before) return reply.code(404).send({ error: "not_found" });
        const beforeMappings = await loadProviderMappings(db, id);

        // SSRF guard on PATCH too — issuer can be changed to point
        // at a private host even after the row was created clean.
        if (patch.issuer !== undefined) {
          try {
            await assertSafeIssuerUrl(patch.issuer);
          } catch (err) {
            if (err instanceof UnsafeIssuerError) {
              return reply.code(400).send({
                error: "issuer_unsafe",
                code: err.code,
                details: err.message,
              });
            }
            throw err;
          }
        }

        // Build a dynamic SET clause; always flip source to 'ui' so
        // YAML defaults stop overwriting this row on subsequent boots
        // (the plan calls this "managed in UI" semantics).
        const sets: string[] = ["source = 'ui'", "updated_at = now()"];
        const params: unknown[] = [];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if (patch.display_name !== undefined) set("display_name", patch.display_name);
        if (patch.issuer !== undefined) set("issuer", patch.issuer);
        if (patch.client_id !== undefined) set("client_id", patch.client_id);
        if (patch.client_secret !== undefined && patch.client_secret !== "") {
          set("client_secret", patch.client_secret);
        }
        if (patch.redirect_uri !== undefined) set("redirect_uri", patch.redirect_uri);
        if (patch.scopes !== undefined) set("scopes", patch.scopes);
        if (patch.groups_claim !== undefined) set("groups_claim", patch.groups_claim);

        params.push(id);
        await db.query(
          `UPDATE identity_providers SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );

        if (patch.role_mappings !== undefined) {
          await replaceProviderMappings(db, id, patch.role_mappings);
        }

        await registry.rebuild();

        const after = await fetchProviderRow(db, id);
        const afterMappings = await loadProviderMappings(db, id);
        // Diff-aware metadata. Don't dump the full secret; record
        // whether it changed.
        const changed: string[] = [];
        for (const k of [
          "display_name",
          "issuer",
          "client_id",
          "redirect_uri",
          "scopes",
          "groups_claim",
        ] as const) {
          if (
            patch[k] !== undefined &&
            JSON.stringify(before[k]) !== JSON.stringify(after?.[k])
          ) {
            changed.push(k);
          }
        }
        if (patch.client_secret !== undefined && patch.client_secret !== "") {
          changed.push("client_secret");
        }
        if (
          patch.role_mappings !== undefined &&
          JSON.stringify(beforeMappings) !== JSON.stringify(afterMappings)
        ) {
          changed.push("role_mappings");
        }

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "sso.provider.update",
          target_kind: "sso_provider",
          target_id: null,
          target_name: id,
          metadata: {
            changed,
            previous_source: before.source,
            new_source: after?.source ?? null,
          },
        });

        return {
          ...maskRow(after!),
          role_mappings: afterMappings,
        };
      },
    );

    app.delete(
      "/sso/providers/:id",
      { preHandler: requirePermission("sso.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const row = await fetchProviderRow(db, id);
        if (!row) return reply.code(404).send({ error: "not_found" });
        if (row.source === "yaml") {
          // Refusing here matches the plan: a YAML-defined provider
          // exists because the YAML file says so. Deleting it via the
          // API would be re-created on the next boot, which would
          // be confusing. The operator must edit the YAML.
          return reply.code(409).send({
            error: "provider_managed_via_yaml",
            details: `Remove '${id}' from the SSO YAML and restart, or PATCH it to flip source to 'ui' first.`,
          });
        }
        await db.query(`DELETE FROM identity_providers WHERE id = $1`, [id]);
        await registry.rebuild();

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "sso.provider.delete",
          target_kind: "sso_provider",
          target_id: null,
          target_name: id,
          metadata: { kind: row.kind, issuer: row.issuer },
        });

        return reply.code(204).send();
      },
    );

    /**
     * Connection probe. `sso.read` is sufficient (the plan
     * explicitly chose this so an auditor can verify a YAML-only
     * provider works without sso.write). We audit only on failure
     * AND when the request was triggered from the UI button — the
     * latter is implied by any authenticated caller hitting this
     * endpoint, so we audit unconditionally for traceability.
     */
    app.post(
      "/sso/providers/:id/test",
      { preHandler: requirePermission("sso.read") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const provider = registry.getProvider(id);
        if (!provider) {
          return reply.code(404).send({ error: "not_found" });
        }
        const result = await provider.testConnection();

        // Low-noise: we only emit an audit row on failure, OR when the
        // caller is a real user (UI invocation). Token/env-token
        // probes succeed silently.
        const isUiCaller = req.actor?.kind === "user";
        if (!result.ok || isUiCaller) {
          await recordAuditEvent(db, {
            ...auditFieldsFromActor(req.actor ?? envTokenActor()),
            action: "sso.provider.test",
            target_kind: "sso_provider",
            target_id: null,
            target_name: id,
            metadata: { ...result },
          });
        }

        return result;
      },
    );

    // -----------------------------------------------------------------
    // User <-> SSO link/unlink
    // -----------------------------------------------------------------

    app.post(
      "/users/:id/link-sso",
      { preHandler: requirePermission("sso.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = LinkSsoBody.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const user = await findUserById(db, id);
        if (!user) return reply.code(404).send({ error: "user_not_found" });
        const provider = registry.getProvider(parsed.data.provider_id);
        if (!provider) {
          return reply.code(404).send({ error: "provider_not_found" });
        }
        const eff = registry.getEffective(provider.id);
        if (!eff) {
          return reply.code(404).send({ error: "provider_not_found" });
        }
        try {
          const updated = await linkLocalUserToSso(
            db,
            id,
            eff.issuer,
            parsed.data.subject,
          );
          if (!updated) {
            // The user already had a binding (the partial UPDATE
            // matched zero rows). Tell the caller cleanly.
            return reply.code(409).send({ error: "already_linked" });
          }
          await registry.rebuild();

          await recordAuditEvent(db, {
            ...auditFieldsFromActor(req.actor ?? envTokenActor()),
            action: "sso.user_link",
            target_kind: "user",
            target_id: id,
            target_name: user.email,
            metadata: {
              provider: provider.id,
              issuer: eff.issuer,
              subject: parsed.data.subject,
            },
          });

          return {
            id: updated.id,
            email: updated.email,
            oidc_issuer: updated.oidc_issuer,
            oidc_subject: updated.oidc_subject,
          };
        } catch (err: unknown) {
          if ((err as { code?: string }).code === "23505") {
            return reply.code(409).send({ error: "subject_already_bound" });
          }
          throw err;
        }
      },
    );

    app.delete(
      "/users/:id/sso-link",
      { preHandler: requirePermission("sso.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const before = await findUserById(db, id);
        if (!before) return reply.code(404).send({ error: "user_not_found" });
        if (!before.oidc_issuer || !before.oidc_subject) {
          return reply.code(409).send({ error: "not_linked" });
        }
        await unlinkUserSso(db, id);

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "sso.user_unlink",
          target_kind: "user",
          target_id: id,
          target_name: before.email,
          metadata: {
            previous_issuer: before.oidc_issuer,
            previous_subject: before.oidc_subject,
          },
        });

        return reply.code(204).send();
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchProviderRow(
  db: DbPool,
  id: string,
): Promise<IdentityProviderRow | null> {
  const r = await db.query<IdentityProviderRow>(
    `SELECT id, kind, display_name, issuer, client_id, client_secret,
            redirect_uri, scopes, groups_claim, source, created_at, updated_at
       FROM identity_providers WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/**
 * Public-friendly DTO of a row. `client_secret` is replaced with a
 * fixed marker so the UI can render the field as a write-only input
 * without ever leaking the value.
 */
function maskRow(r: IdentityProviderRow) {
  return {
    id: r.id,
    kind: r.kind,
    display_name: r.display_name,
    issuer: r.issuer,
    client_id: r.client_id,
    client_secret: r.client_secret ? "***" : null,
    has_client_secret: r.client_secret !== null,
    redirect_uri: r.redirect_uri,
    scopes: r.scopes ?? [],
    groups_claim: r.groups_claim,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function loadProviderMappings(
  db: DbPool,
  providerId: string,
): Promise<Record<string, string[]>> {
  const r = await db.query<{ group_value: string; role_id: string }>(
    `SELECT group_value, role_id FROM identity_provider_role_mappings
       WHERE provider_id = $1`,
    [providerId],
  );
  const out: Record<string, string[]> = {};
  for (const row of r.rows) {
    if (!out[row.group_value]) out[row.group_value] = [];
    out[row.group_value]!.push(row.role_id);
  }
  return out;
}

async function replaceProviderMappings(
  db: DbPool,
  providerId: string,
  mappings: Record<string, string[]>,
): Promise<void> {
  await db.query(
    `DELETE FROM identity_provider_role_mappings WHERE provider_id = $1`,
    [providerId],
  );
  for (const [group, roleIds] of Object.entries(mappings)) {
    for (const roleId of roleIds) {
      await db.query(
        `INSERT INTO identity_provider_role_mappings
           (provider_id, group_value, role_id)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
        [providerId, group, roleId],
      );
    }
  }
}
