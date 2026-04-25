/**
 * Tests for the audit-metadata sanitizer.
 *
 * The sanitizer is the only thing keeping a future contributor from
 * accidentally writing a plaintext secret into the audit table —
 * audit rows get exported for compliance review, so the cost of a
 * single leak there is high. Test every transition.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeAuditMetadata } from "./audit.js";

describe("sanitizeAuditMetadata", () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("passes through metadata that has no secrets", () => {
    const input = {
      changed: ["name", "disabled"],
      role_ids: ["a", "b"],
      session_id: "abc-123",
    };
    expect(sanitizeAuditMetadata(input)).toEqual(input);
  });

  it("does NOT redact look-alike safe keys", () => {
    // These appear elsewhere in legitimate audit metadata; if they
    // ever start being flagged, the sanitizer is too aggressive.
    const safe = {
      token_prefix: "fmt_a1b2c3d4",
      token_id: "uuid",
      actor_token_id: "uuid",
      session_id: "abc",
    };
    expect(sanitizeAuditMetadata(safe)).toEqual(safe);
  });

  it.each([
    "password",
    "current_password",
    "new_password",
    "old_password",
    "password_hash",
    "client_secret",
    "secret",
    "token",
    "token_hash",
    "api_key",
    "api_secret",
    "private_key",
  ])("throws in non-prod when metadata contains '%s'", (key) => {
    process.env.NODE_ENV = "development";
    expect(() => sanitizeAuditMetadata({ [key]: "leak-me" })).toThrow(/forbidden key/);
  });

  it("redacts (does not throw) in production", () => {
    process.env.NODE_ENV = "production";
    expect(sanitizeAuditMetadata({ password: "hunter2" })).toEqual({
      password: "[redacted]",
    });
  });

  it("recurses into nested objects", () => {
    process.env.NODE_ENV = "development";
    expect(() =>
      sanitizeAuditMetadata({ before: { name: "ok", password: "leak" } }),
    ).toThrow(/before.password/);
  });

  it("recurses into arrays", () => {
    process.env.NODE_ENV = "development";
    expect(() =>
      sanitizeAuditMetadata({ history: [{ token: "leak" }] }),
    ).toThrow(/history\[0\].token/);
  });

  it("preserves null and primitive values", () => {
    expect(
      sanitizeAuditMetadata({
        x: null,
        y: 42,
        z: true,
        arr: [1, "two", null],
      }),
    ).toEqual({ x: null, y: 42, z: true, arr: [1, "two", null] });
  });
});
