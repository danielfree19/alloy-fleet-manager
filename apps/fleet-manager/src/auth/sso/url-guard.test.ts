/**
 * Tests for the OIDC SSRF guard.
 *
 * The guard is the only thing standing between an admin-coerced
 * `Issuer.discover()` and the cloud metadata service, so the bar
 * here is "every reject case is exercised". Pure-function tests —
 * no DB, no network beyond the local resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UnsafeIssuerError,
  assertSafeIssuerUrl,
  isPrivateAddress,
} from "./url-guard.js";

const ENV_KEY = "FLEET_SSO_ALLOW_INSECURE_ISSUER";

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // AWS / Azure / GCP metadata
    ["100.64.0.1", true], // CGNAT
    ["0.0.0.0", true],
    ["224.0.0.1", true], // multicast
    ["198.18.0.1", true], // benchmarking
    ["::1", true],
    ["fe80::1", true],
    ["fc00::1", true], // ULA
    ["ff00::1", true],
    // Public addresses — must NOT be flagged.
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["172.32.0.1", false], // just past RFC1918
    ["169.255.0.1", false], // just past link-local
    ["2606:4700:4700::1111", false], // 1.1.1.1 v6
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("returns false for malformed input rather than throwing", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(false);
    expect(isPrivateAddress("")).toBe(false);
  });
});

describe("assertSafeIssuerUrl", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeIssuerUrl("not a url")).rejects.toThrow(UnsafeIssuerError);
  });

  it("rejects non-http(s) protocols (file://, gopher://, etc.)", async () => {
    await expect(assertSafeIssuerUrl("file:///etc/passwd")).rejects.toMatchObject({
      code: "unsupported_protocol",
    });
    await expect(assertSafeIssuerUrl("gopher://example.com")).rejects.toMatchObject({
      code: "unsupported_protocol",
    });
  });

  it("rejects http:// without the escape hatch", async () => {
    await expect(assertSafeIssuerUrl("http://example.com")).rejects.toMatchObject({
      code: "https_required",
    });
  });

  it("allows http:// when the escape hatch is set", async () => {
    process.env[ENV_KEY] = "1";
    // Should not throw — the escape hatch also bypasses the
    // private-address check, so we don't even need to mock DNS.
    await expect(assertSafeIssuerUrl("http://example.com")).resolves.toBeUndefined();
  });

  it("rejects URLs whose hostname resolves only to a private address", async () => {
    // localhost is guaranteed to resolve to 127.0.0.1 / ::1 on every
    // platform we care about, so this exercises the post-DNS check
    // without needing a mock.
    await expect(assertSafeIssuerUrl("https://localhost")).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("rejects literal private IPs in the hostname", async () => {
    await expect(assertSafeIssuerUrl("https://169.254.169.254/")).rejects.toMatchObject({
      code: "private_address",
      detail: "169.254.169.254",
    });
    await expect(assertSafeIssuerUrl("https://10.0.0.1/")).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("escape hatch bypasses the private-address check too", async () => {
    process.env[ENV_KEY] = "1";
    await expect(
      assertSafeIssuerUrl("http://localhost:8080/realms/fleet"),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeIssuerUrl("https://10.0.0.1/auth"),
    ).resolves.toBeUndefined();
  });
});
