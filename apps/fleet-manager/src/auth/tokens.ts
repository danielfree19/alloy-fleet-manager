import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  // 32 bytes = 256 bits of entropy, encoded as base64url without padding.
  return randomBytes(32).toString("base64url");
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
