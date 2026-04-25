/**
 * Pure-function tests for the lockout helpers in auth/users.ts.
 *
 * The state-machine query (recordLoginFailure) needs Postgres and is
 * exercised by scripts/e2e-terraform.sh. The pure helpers below have
 * unit coverage here.
 */
import { describe, expect, it } from "vitest";
import {
  LOGIN_FAILURE_LOCK_THRESHOLD,
  LOGIN_LOCK_DURATION_MS,
  isAccountLocked,
} from "./users.js";

describe("isAccountLocked", () => {
  it("returns false when locked_until is null", () => {
    expect(isAccountLocked({ locked_until: null })).toBe(false);
  });

  it("returns true when locked_until is in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isAccountLocked({ locked_until: future })).toBe(true);
  });

  it("returns false when locked_until has elapsed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isAccountLocked({ locked_until: past })).toBe(false);
  });
});

describe("lockout policy constants", () => {
  it("threshold is set to a reasonable value (3-10)", () => {
    // Sanity guard — wildly off values usually indicate a typo. We
    // don't pin to an exact number to keep tweaks low-friction.
    expect(LOGIN_FAILURE_LOCK_THRESHOLD).toBeGreaterThanOrEqual(3);
    expect(LOGIN_FAILURE_LOCK_THRESHOLD).toBeLessThanOrEqual(10);
  });

  it("lock duration is at least one minute and at most an hour", () => {
    expect(LOGIN_LOCK_DURATION_MS).toBeGreaterThanOrEqual(60_000);
    expect(LOGIN_LOCK_DURATION_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});
