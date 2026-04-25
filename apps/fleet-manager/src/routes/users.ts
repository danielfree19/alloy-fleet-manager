/**
 * User & role admin endpoints.
 *
 * `users.read`  — list users + their roles
 * `users.write` — create/update/disable users, assign roles, reset passwords,
 *                 manage custom roles (built-in roles are immutable here)
 *
 * The DELETE-user path is intentionally implemented as `disabled = true`
 * not a hard DELETE: deleting a user would cascade to their api_tokens
 * (FK ON DELETE CASCADE) and orphan audit_events.actor_user_id (set
 * null). Disabling preserves the audit trail. Admins who really want
 * to delete a user can call DELETE /users/:id explicitly.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db/pool.js";
import { makeRequirePermission } from "../auth/middleware.js";
import { envTokenActor, isPermission, type Permission } from "../auth/permissions.js";
import { deleteSessionsForUser } from "../auth/sessions.js";
import { auditFieldsFromActor, recordAuditEvent } from "../services/audit.js";
import {
  clearLoginFailures,
  countActiveAdmins,
  createCustomRole,
  createUser,
  deleteCustomRole,
  deleteUser,
  findRoleById,
  findUserById,
  listRolePermissions,
  listRoles,
  listUserRoles,
  listUsers,
  setPassword,
  setRolePermissions,
  setUserRoles,
  updateUser,
  userHasAdminRole,
} from "../auth/users.js";

const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().nullish(),
  password: z.string().min(8).optional(),
  role_ids: z.array(z.string().uuid()).optional(),
});

const UpdateUserBody = z.object({
  name: z.string().nullish(),
  disabled: z.boolean().optional(),
  role_ids: z.array(z.string().uuid()).optional(),
  /**
   * Admin escape hatch for the per-account login lockout. Set to
   * `true` to clear the failure counter and any active lock — never
   * accepts `false` because "re-locking" on demand has no sane use
   * case (operators wanting that should disable the account instead).
   */
  unlock: z.literal(true).optional(),
});

const ResetPasswordBody = z.object({
  new_password: z.string().min(8),
});

const CreateRoleBody = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "name must be lowercase slug"),
  description: z.string().default(""),
  permissions: z.array(z.string()),
});

const UpdateRoleBody = z.object({
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

export function registerUserRoutes(config: AppConfig, db: DbPool): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const requirePermission = makeRequirePermission({
      db,
      adminToken: config.ADMIN_TOKEN,
    });

    // -----------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------

    app.get(
      "/users",
      { preHandler: requirePermission("users.read") },
      async () => {
        const users = await listUsers(db);
        const out = await Promise.all(
          users.map(async (u) => {
            const roles = await listUserRoles(db, u.id);
            return {
              id: u.id,
              email: u.email,
              name: u.name,
              has_password: u.password_hash !== null,
              oidc_issuer: u.oidc_issuer,
              oidc_subject: u.oidc_subject,
              disabled: u.disabled,
              created_at: u.created_at,
              updated_at: u.updated_at,
              roles: roles.map((r) => ({ id: r.id, name: r.name })),
            };
          }),
        );
        return { users: out };
      },
    );

    app.get(
      "/users/:id",
      { preHandler: requirePermission("users.read") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const user = await findUserById(db, id);
        if (!user) return reply.code(404).send({ error: "not_found" });
        const roles = await listUserRoles(db, id);
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          has_password: user.password_hash !== null,
          oidc_issuer: user.oidc_issuer,
          oidc_subject: user.oidc_subject,
          disabled: user.disabled,
          created_at: user.created_at,
          updated_at: user.updated_at,
          roles: roles.map((r) => ({ id: r.id, name: r.name })),
        };
      },
    );

    app.post(
      "/users",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const parsed = CreateUserBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const input = parsed.data;
        try {
          const user = await createUser(db, {
            email: input.email,
            name: input.name ?? null,
            password: input.password ?? null,
            roleIds: input.role_ids,
          });
          const roles = await listUserRoles(db, user.id);

          await recordAuditEvent(db, {
            ...auditFieldsFromActor(req.actor ?? envTokenActor()),
            action: "user.create",
            target_kind: "user",
            target_id: user.id,
            target_name: user.email,
            metadata: {
              email: user.email,
              has_password: user.password_hash !== null,
              role_ids: roles.map((r) => r.id),
              role_names: roles.map((r) => r.name),
            },
          });

          return reply.code(201).send({
            id: user.id,
            email: user.email,
            name: user.name,
            has_password: user.password_hash !== null,
            disabled: user.disabled,
            created_at: user.created_at,
            roles: roles.map((r) => ({ id: r.id, name: r.name })),
          });
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code === "23505") {
            return reply.code(409).send({ error: "email_taken" });
          }
          throw err;
        }
      },
    );

    app.patch(
      "/users/:id",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = UpdateUserBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const patch = parsed.data;

        // Last-admin-lockout guard. Two distinct ways this PATCH can
        // strip the system of its last admin:
        //   1. Setting `disabled = true` on a user who is currently
        //      an admin AND no other active admins exist.
        //   2. Setting `role_ids` to a list that no longer includes
        //      the built-in admin role on a user who currently has it.
        // We refuse before mutating so the request is fully atomic.
        const willDisable = patch.disabled === true;
        const willChangeRoles = Array.isArray(patch.role_ids);
        if (willDisable || willChangeRoles) {
          const isAdminNow = await userHasAdminRole(db, id);
          if (isAdminNow) {
            // For role updates we only care if admin is being REMOVED.
            const adminRoleStripped =
              willChangeRoles &&
              !(await containsBuiltinAdminRole(db, patch.role_ids ?? []));
            const triggers = willDisable || adminRoleStripped;
            if (triggers) {
              const remaining = await countActiveAdmins(db, { excludeUserId: id });
              if (remaining === 0) {
                return reply.code(400).send({
                  error: "last_admin_lockout",
                  details:
                    "This user is the only active admin. Promote another user to admin before disabling this one or removing their admin role.",
                });
              }
            }
          }
        }

        // Snapshot BEFORE so the audit can describe what actually changed.
        const before = await findUserById(db, id);
        const beforeRoles = before ? await listUserRoles(db, id) : [];

        const updated = await updateUser(db, id, {
          name: patch.name ?? undefined,
          disabled: patch.disabled,
        });
        if (!updated) return reply.code(404).send({ error: "not_found" });
        if (patch.role_ids) {
          await setUserRoles(db, id, patch.role_ids);
        }
        if (patch.disabled === true) {
          // Disabling a user must invalidate their active sessions
          // immediately — otherwise a fired user could keep using the
          // app until their cookie expires. This also signs out the
          // caller if they just disabled themselves.
          await deleteSessionsForUser(db, id);
        }
        if (patch.unlock === true) {
          await clearLoginFailures(db, id);
          // Audit unlock as its own row so an auditor can find every
          // operator-initiated lock-clear without parsing user.update
          // metadata.
          await recordAuditEvent(db, {
            ...auditFieldsFromActor(req.actor ?? envTokenActor()),
            action: "user.unlock",
            target_kind: "user",
            target_id: id,
            target_name: updated.email,
            metadata: {},
          });
        }
        const roles = await listUserRoles(db, id);

        // Compute the diff. Only emit `changed` fields so a name-only
        // tweak isn't visually conflated with an admin role swap.
        const changed: string[] = [];
        if (before && before.name !== updated.name) changed.push("name");
        if (before && before.disabled !== updated.disabled) changed.push("disabled");
        if (patch.unlock === true) changed.push("unlock");
        if (patch.role_ids) {
          const beforeIds = new Set(beforeRoles.map((r) => r.id));
          const afterIds = new Set(roles.map((r) => r.id));
          const sameSize = beforeIds.size === afterIds.size;
          const sameContents =
            sameSize && [...beforeIds].every((rid) => afterIds.has(rid));
          if (!sameContents) changed.push("role_ids");
        }
        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "user.update",
          target_kind: "user",
          target_id: updated.id,
          target_name: updated.email,
          metadata: {
            changed,
            before: before
              ? {
                  name: before.name,
                  disabled: before.disabled,
                  role_ids: beforeRoles.map((r) => r.id),
                  role_names: beforeRoles.map((r) => r.name),
                }
              : null,
            after: {
              name: updated.name,
              disabled: updated.disabled,
              role_ids: roles.map((r) => r.id),
              role_names: roles.map((r) => r.name),
            },
            sessions_invalidated: patch.disabled === true,
            self_target: req.actor?.userId === id,
          },
        });

        return {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          has_password: updated.password_hash !== null,
          disabled: updated.disabled,
          updated_at: updated.updated_at,
          roles: roles.map((r) => ({ id: r.id, name: r.name })),
        };
      },
    );

    app.post(
      "/users/:id/password",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const parsed = ResetPasswordBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const user = await findUserById(db, id);
        if (!user) return reply.code(404).send({ error: "not_found" });
        await setPassword(db, id, parsed.data.new_password);
        // Force re-login on every device.
        await deleteSessionsForUser(db, id);

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "user.password.reset",
          target_kind: "user",
          target_id: user.id,
          target_name: user.email,
          metadata: {
            sessions_invalidated: true,
            self_target: req.actor?.userId === id,
          },
        });

        return reply.code(204).send();
      },
    );

    app.delete(
      "/users/:id",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        // Refuse to delete yourself — too easy to lock yourself out,
        // and a hard delete also drops your audit attribution.
        if (req.actor?.userId === id) {
          return reply.code(400).send({ error: "cannot_delete_self" });
        }
        // Same last-admin-lockout guard as PATCH disable. DELETE is
        // strictly stronger than disable, so the same condition applies.
        if (await userHasAdminRole(db, id)) {
          const remaining = await countActiveAdmins(db, { excludeUserId: id });
          if (remaining === 0) {
            return reply.code(400).send({
              error: "last_admin_lockout",
              details:
                "This user is the only active admin. Promote another user to admin before deleting this one.",
            });
          }
        }
        // Capture identifying fields BEFORE the delete so the audit
        // row can still describe who was removed (target_id is set
        // null after a hard delete cascades audit_events.actor_user_id,
        // but target_name/email survive).
        const victim = await findUserById(db, id);
        const victimRoles = victim ? await listUserRoles(db, id) : [];

        const ok = await deleteUser(db, id);
        if (!ok) return reply.code(404).send({ error: "not_found" });

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "user.delete",
          target_kind: "user",
          target_id: id,
          target_name: victim?.email ?? null,
          metadata: {
            email: victim?.email ?? null,
            role_names: victimRoles.map((r) => r.name),
          },
        });

        return reply.code(204).send();
      },
    );

    // -----------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------

    app.get(
      "/roles",
      { preHandler: requirePermission("users.read") },
      async () => {
        const roles = await listRoles(db);
        const out = await Promise.all(
          roles.map(async (r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            builtin: r.builtin,
            created_at: r.created_at,
            permissions: await listRolePermissions(db, r.id),
          })),
        );
        return { roles: out };
      },
    );

    app.post(
      "/roles",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const parsed = CreateRoleBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const { name, description, permissions } = parsed.data;
        const validated = validatePermissionList(permissions);
        if (!validated.ok) {
          return reply
            .code(400)
            .send({ error: "invalid_permission", details: validated.invalid });
        }
        try {
          const role = await createCustomRole(db, name, description, validated.perms);

          await recordAuditEvent(db, {
            ...auditFieldsFromActor(req.actor ?? envTokenActor()),
            action: "role.create",
            target_kind: "role",
            target_id: role.id,
            target_name: role.name,
            metadata: {
              description: role.description,
              builtin: role.builtin,
              permissions: validated.perms,
            },
          });

          return reply.code(201).send({
            id: role.id,
            name: role.name,
            description: role.description,
            builtin: role.builtin,
            permissions: validated.perms,
          });
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code === "23505") {
            return reply.code(409).send({ error: "role_name_taken" });
          }
          throw err;
        }
      },
    );

    app.patch(
      "/roles/:id",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const role = await findRoleById(db, id);
        if (!role) return reply.code(404).send({ error: "not_found" });
        if (role.builtin) {
          return reply
            .code(400)
            .send({ error: "builtin_role", details: "Built-in roles cannot be edited." });
        }
        const parsed = UpdateRoleBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
        }
        const patch = parsed.data;
        const beforePerms = await listRolePermissions(db, id);
        const beforeDescription = role.description;

        if (patch.description !== undefined) {
          await db.query(`UPDATE roles SET description = $1 WHERE id = $2`, [
            patch.description,
            id,
          ]);
        }
        if (patch.permissions) {
          const validated = validatePermissionList(patch.permissions);
          if (!validated.ok) {
            return reply
              .code(400)
              .send({ error: "invalid_permission", details: validated.invalid });
          }
          await setRolePermissions(db, id, validated.perms);
        }
        const updated = await findRoleById(db, id);
        const perms = await listRolePermissions(db, id);

        const changed: string[] = [];
        if (
          patch.description !== undefined &&
          patch.description !== beforeDescription
        ) {
          changed.push("description");
        }
        if (patch.permissions) {
          const beforeSet = new Set(beforePerms);
          const afterSet = new Set(perms);
          const sameSize = beforeSet.size === afterSet.size;
          const sameContents =
            sameSize && [...beforeSet].every((p) => afterSet.has(p));
          if (!sameContents) changed.push("permissions");
        }
        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "role.update",
          target_kind: "role",
          target_id: id,
          target_name: updated?.name ?? role.name,
          metadata: {
            changed,
            before: { description: beforeDescription, permissions: beforePerms },
            after: { description: updated?.description ?? null, permissions: perms },
          },
        });

        return { ...updated, permissions: perms };
      },
    );

    app.delete(
      "/roles/:id",
      { preHandler: requirePermission("users.write") },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const role = await findRoleById(db, id);
        if (!role) return reply.code(404).send({ error: "not_found" });
        if (role.builtin) {
          return reply
            .code(400)
            .send({ error: "builtin_role", details: "Built-in roles cannot be deleted." });
        }
        const beforePerms = await listRolePermissions(db, id);
        await deleteCustomRole(db, id);

        await recordAuditEvent(db, {
          ...auditFieldsFromActor(req.actor ?? envTokenActor()),
          action: "role.delete",
          target_kind: "role",
          target_id: id,
          target_name: role.name,
          metadata: {
            description: role.description,
            permissions: beforePerms,
          },
        });

        return reply.code(204).send();
      },
    );
  };
}

function validatePermissionList(
  list: string[],
): { ok: true; perms: Permission[] } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const perms: Permission[] = [];
  for (const p of list) {
    if (isPermission(p)) perms.push(p);
    else invalid.push(p);
  }
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, perms };
}

/**
 * Resolve role IDs and report whether the built-in admin role is
 * among them. Used by the last-admin-lockout guard to detect
 * "stripping the admin role" via PATCH role_ids.
 */
async function containsBuiltinAdminRole(
  db: DbPool,
  roleIds: string[],
): Promise<boolean> {
  if (roleIds.length === 0) return false;
  const r = await db.query<{ name: string; builtin: boolean }>(
    `SELECT name, builtin FROM roles WHERE id = ANY($1::uuid[])`,
    [roleIds],
  );
  return r.rows.some((row) => row.builtin && row.name === "admin");
}
