/**
 * Password hashing.
 *
 * We use bcryptjs (pure JS, no native compile) over node `crypto.scrypt`
 * because:
 *   - bcrypt is the most widely-recognized password hash, easy to
 *     export to other tools.
 *   - bcryptjs has no build-time deps, which matters for our
 *     Alpine-based Docker image.
 *
 * Cost factor 12 — ~250ms per hash on a modern CPU. High enough to
 * make brute force expensive but low enough that login latency stays
 * imperceptible.
 *
 * Argon2id would be a marginally better choice in 2024+ but adds a
 * native build step. Easy to migrate later: hashes are
 * self-describing (`$2a$...` vs `$argon2id$...`) so we can detect the
 * algorithm at verify time and rehash on next login.
 */
import bcrypt from "bcryptjs";

const COST_FACTOR = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return bcrypt.hash(plain, COST_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // bcrypt.compare is timing-safe internally.
  return bcrypt.compare(plain, hash);
}
