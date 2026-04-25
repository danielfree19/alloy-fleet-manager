import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { hashApiKey, timingSafeEqualHex } from "./tokens.js";

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m && m[1] ? m[1] : null;
}

/** Admin auth: static ADMIN_TOKEN from environment. */
export function makeAdminAuth(adminToken: string) {
  return async function adminAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractBearer(req);
    if (!token || token !== adminToken) {
      reply.code(401).send({ error: "unauthorized", scope: "admin" });
      return;
    }
    // Stash a non-reversible identifier derived from the bearer. The audit
    // log needs this but we never want to put raw tokens in any log or DB
    // row. First 8 hex chars of SHA-256 is enough to distinguish tokens.
    const digest = createHash("sha256").update(token).digest("hex").slice(0, 8);
    req.adminActor = `admin-token:${digest}`;
  };
}

/**
 * Registration auth: a second static REGISTRATION_TOKEN, used only by
 * POST /collectors/register. Kept separate from ADMIN_TOKEN so agents can
 * be provisioned without handing out full admin privileges.
 */
export function makeRegistrationAuth(registrationToken: string) {
  return async function regAuth(req: FastifyRequest, reply: FastifyReply) {
    const token = extractBearer(req);
    if (!token || token !== registrationToken) {
      reply.code(401).send({ error: "unauthorized", scope: "registration" });
    }
  };
}

declare module "fastify" {
  interface FastifyRequest {
    collectorId?: string;
    /** Set by `makeAdminAuth` to a stable, non-reversible caller identifier. */
    adminActor?: string;
  }
}

/**
 * Agent auth: verifies the Bearer token matches the sha256(api_key_hash)
 * stored for the collector identified in the URL parameter `:collector_id`.
 */
export function makeAgentAuth(lookupHash: (collectorId: string) => Promise<string | null>) {
  return async function agentAuth(req: FastifyRequest, reply: FastifyReply) {
    const collectorId = (req.params as Record<string, string> | undefined)?.collector_id;
    if (!collectorId) {
      return reply.code(400).send({ error: "missing collector_id in path" });
    }
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", scope: "agent" });
    }
    const expected = await lookupHash(collectorId);
    if (!expected) {
      return reply.code(404).send({ error: "collector not found" });
    }
    const actual = hashApiKey(token);
    if (!timingSafeEqualHex(actual, expected)) {
      return reply.code(401).send({ error: "unauthorized", scope: "agent" });
    }
    req.collectorId = collectorId;
  };
}
