/**
 * API token endpoints.
 *
 * Two distinct authorization rules:
 *
 *  - Self-service (always allowed for any authenticated USER):
 *    list, create, revoke OWN tokens. Convenience for engineers who
 *    want to mint a personal token for fleetctl/CI without being a
 *    full admin.
 *
 *  - Cross-user management (gated by `tokens.read` / `tokens.write`):
 *    list/create/revoke tokens belonging to OTHER users. This is
 *    typically only granted to the `admin` built-in role.
 *
 * Tokens carry roles. A creator can only assign roles they themselves
 * possess — you can't escalate privileges by minting a token with
 * roles you don't have. The env-token actor (ADMIN_TOKEN bearer) can
 * assign anything.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import {
  makeRequireAuthenticated,
  makeRequirePermission,
} from "../auth/middleware.js";
import {
  createApiToken,
  findApiTokenById,
  listApiTokens,
  revokeApiToken,
} from "../auth/api-tokens.js";
import { actorHasPermission } from "../auth/permissions.js";
import { findRoleById, listUserRoles } from "../auth/users.js";
import { auditFieldsFromActor, recordAuditEvent } from "../services/audit.js";

const CreateTokenBody = z.object({
  name: z.string().min(1).max(80),
  user_id: z.string().uuid().optional(),       // admins can mint tokens for other users
  role_ids: z.array(z.string().uuid()).default([]),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable(),
});

export function registerTokenRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const requireAuthenticated = makeRequireAuthenticated({
      db,
      adminToken: config.ADMIN_TOKEN,
    });
    const requirePermission = makeRequirePermission({
      db,
      adminToken: config.ADMIN_TOKEN,
    });

    /**
     * List tokens. Without `tokens.read` you only see your own.
     * Query param `user=me` is the explicit form; we always default
     * to the caller when the actor doesn't have global token-read.
     */
    app.get(
      "/tokens",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        const q = (req.query ?? {}) as Record<string, string | undefined>;

        // Default scope = own tokens. Explicit ?user=<id> requires
        // tokens.read unless it's your own id.
        const targetUserId =
          !q.user || q.user === "me"
            ? actor.userId
            : q.user;

        if (!targetUserId) {
          // Env-token actor with no user_id can't have tokens.
          return reply.code(400).send({ error: "no_user_context" });
        }
        if (
          targetUserId !== actor.userId &&
          !actorHasPermission(actor, "tokens.read")
        ) {
          return reply.code(403).send({ error: "forbidden", permission: "tokens.read" });
        }

        const tokens = await listApiTokens(db, { user_id: targetUserId });
        return { tokens };
      },
    );

    /**
     * Create a new API token. The plaintext is returned ONCE in the
     * response — there is no way to recover it later. The UI must
     * surface this clearly.
     */
    app.post(
      "/tokens",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        const parsed = CreateTokenBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const { name, user_id, role_ids, expires_at } = parsed.data;

        const targetUserId = user_id ?? actor.userId;
        if (!targetUserId) {
          return reply.code(400).send({ error: "no_user_context" });
        }
        // Cross-user mint requires tokens.write.
        if (
          targetUserId !== actor.userId &&
          !actorHasPermission(actor, "tokens.write")
        ) {
          return reply.code(403).send({ error: "forbidden", permission: "tokens.write" });
        }

        // Validate every requested role exists.
        const requestedRoles = await Promise.all(
          role_ids.map((id) => findRoleById(db, id)),
        );
        if (requestedRoles.some((r) => r === null)) {
          return reply.code(400).send({ error: "unknown_role" });
        }

        // Privilege containment: a non-env actor can only attach
        // roles they themselves hold. Env tokens are exempt because
        // they're already the highest privilege.
        if (actor.kind !== "env_token") {
          const callerRoles = await listUserRoles(db, actor.userId!);
          const callerRoleIds = new Set(callerRoles.map((r) => r.id));
          for (const r of requestedRoles) {
            if (r && !callerRoleIds.has(r.id)) {
              return reply.code(403).send({
                error: "role_not_held_by_creator",
                details: `You cannot assign role '${r.name}' to a token because you don't have it yourself.`,
              });
            }
          }
        }

        const { token, row } = await createApiToken(db, {
          user_id: targetUserId,
          name,
          expires_at: expires_at ? new Date(expires_at) : null,
          role_ids,
        });

        // Audit. We log token_prefix (already public, also stored in
        // the row) but NEVER the plaintext `token`. role_names is
        // resolved up-front so the audit entry stays human-readable
        // even if the role is later renamed or deleted.
        await recordAuditEvent(db, {
          ...auditFieldsFromActor(actor),
          action: "token.create",
          target_kind: "api_token",
          target_id: row.id,
          target_name: row.name,
          metadata: {
            owner_user_id: row.user_id,
            cross_user: targetUserId !== actor.userId,
            token_prefix: row.token_prefix,
            expires_at: row.expires_at,
            role_ids,
            role_names: requestedRoles
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .map((r) => r.name),
          },
        });

        return reply.code(201).send({
          // Returned EXACTLY ONCE. Treat like a password.
          token,
          api_token: {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            token_prefix: row.token_prefix,
            expires_at: row.expires_at,
            revoked_at: row.revoked_at,
            created_at: row.created_at,
            roles: requestedRoles
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .map((r) => ({ id: r.id, name: r.name })),
          },
        });
      },
    );

    /**
     * Get a single token by id. Auth mirrors DELETE: owner can always
     * read their own; reading someone else's needs `tokens.read`.
     * Plaintext is NEVER returned (only available once at creation).
     */
    app.get(
      "/tokens/:id",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        const { id } = req.params as { id: string };
        const token = await findApiTokenById(db, id);
        if (!token) return reply.code(404).send({ error: "not_found" });
        if (
          token.user_id !== actor.userId &&
          !actorHasPermission(actor, "tokens.read")
        ) {
          return reply.code(403).send({ error: "forbidden", permission: "tokens.read" });
        }
        // Build the same per-token role list shape that listApiTokens returns,
        // so callers (notably the Terraform provider) can use one DTO.
        const rolesRows = await db.query<{ id: string; name: string }>(
          `SELECT r.id, r.name
             FROM api_token_roles tr
             JOIN roles r ON r.id = tr.role_id
            WHERE tr.api_token_id = $1
            ORDER BY r.name`,
          [id],
        );
        return {
          id: token.id,
          user_id: token.user_id,
          name: token.name,
          token_prefix: token.token_prefix,
          expires_at: token.expires_at,
          revoked_at: token.revoked_at,
          last_used_at: token.last_used_at,
          created_at: token.created_at,
          roles: rolesRows.rows,
        };
      },
    );

    /**
     * Revoke a token. Owner can always revoke their own; revoking
     * someone else's needs `tokens.write`.
     */
    app.delete(
      "/tokens/:id",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        const { id } = req.params as { id: string };
        const token = await findApiTokenById(db, id);
        if (!token) return reply.code(404).send({ error: "not_found" });
        if (
          token.user_id !== actor.userId &&
          !actorHasPermission(actor, "tokens.write")
        ) {
          return reply.code(403).send({ error: "forbidden", permission: "tokens.write" });
        }
        const ok = await revokeApiToken(db, id);
        if (!ok) return reply.code(409).send({ error: "already_revoked" });

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(actor),
          action: "token.revoke",
          target_kind: "api_token",
          target_id: token.id,
          target_name: token.name,
          metadata: {
            owner_user_id: token.user_id,
            cross_user: token.user_id !== actor.userId,
            token_prefix: token.token_prefix,
          },
        });

        return reply.code(204).send();
      },
    );

    /**
     * Cross-user listing convenience: GET /users/:id/tokens.
     * Required permission depends on whether you're asking about
     * yourself or someone else.
     */
    app.get(
      "/users/:id/tokens",
      { preHandler: requireAuthenticated },
      async (req, reply) => {
        const actor = req.actor!;
        const { id } = req.params as { id: string };
        if (
          id !== actor.userId &&
          !actorHasPermission(actor, "tokens.read")
        ) {
          return reply.code(403).send({ error: "forbidden", permission: "tokens.read" });
        }
        const tokens = await listApiTokens(db, { user_id: id });
        return { tokens };
      },
    );

    // Suppress unused warning — kept exported for future
    // permission-gated extensions (bulk-revoke, etc.).
    void requirePermission;
  };
}
