/**
 * SSRF guard for OIDC outbound requests.
 *
 * The OIDC `issuer` URL is operator-supplied (YAML config or admin UI).
 * Without a guard, a coerced or malicious admin can point the manager
 * at:
 *
 *   - cloud metadata services (169.254.169.254 on AWS/GCP/Azure),
 *   - internal-only services on the same VPC,
 *   - localhost services on the manager host itself.
 *
 * `Issuer.discover()`, the JWKS fetch, the token exchange, and the
 * /userinfo call all hit operator-controlled URLs and follow HTTP
 * redirects — so a string-level URL check is necessary but NOT
 * sufficient. We need to also block at TCP-connect time so:
 *
 *   1. DNS rebinding (host resolves to public IP at validation time
 *      but private IP at connect time) is caught.
 *   2. HTTP redirects to private hosts are caught even though their
 *      URLs were never validated by us.
 *
 * Implementation:
 *
 *   1. `assertSafeIssuerUrl(url)`: pre-flight string + DNS check.
 *      Used at the YAML loader and admin POST/PATCH validators so
 *      misconfigurations fail with a clear error.
 *   2. `ssrfSafeLookup`: a Node-native `LookupFunction` injected
 *      into openid-client's HTTP layer via `custom.setHttpOptionsDefaults`.
 *      Every outbound socket connection runs through this lookup,
 *      so a redirect or DNS rebinding to a private address fails
 *      the connection.
 *
 * Escape hatch: `FLEET_SSO_ALLOW_INSECURE_ISSUER=1` disables both
 * the HTTPS requirement AND the private-address ban. The expected
 * use case is local Keycloak in docker-compose. Documented in
 * docs/sso.md.
 */
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

const ALLOW_INSECURE_ENV = "FLEET_SSO_ALLOW_INSECURE_ISSUER";

export class UnsafeIssuerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_url"
      | "unsupported_protocol"
      | "https_required"
      | "private_address",
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "UnsafeIssuerError";
  }
}

export function isInsecureIssuerAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_INSECURE_ENV] === "1";
}

/**
 * Subnet table. Anything that resolves into one of these CIDRs is
 * rejected. Sourced from RFC1918, RFC4193, RFC6598, RFC3927,
 * RFC5737/RFC2544, plus loopback and multicast. Kept explicit (not
 * computed via `os.networkInterfaces()`) so the policy doesn't
 * change with the deployment's network topology.
 */
const PRIVATE_V4_CIDRS: ReadonlyArray<{ addr: string; bits: number }> = [
  { addr: "0.0.0.0", bits: 8 }, // "this network"
  { addr: "10.0.0.0", bits: 8 }, // RFC1918
  { addr: "100.64.0.0", bits: 10 }, // RFC6598 carrier-grade NAT
  { addr: "127.0.0.0", bits: 8 }, // loopback
  { addr: "169.254.0.0", bits: 16 }, // RFC3927 link-local + cloud metadata
  { addr: "172.16.0.0", bits: 12 }, // RFC1918
  { addr: "192.0.0.0", bits: 24 }, // IETF protocol assignments
  { addr: "192.168.0.0", bits: 16 }, // RFC1918
  { addr: "198.18.0.0", bits: 15 }, // RFC2544 benchmarking
  { addr: "224.0.0.0", bits: 4 }, // multicast
  { addr: "240.0.0.0", bits: 4 }, // reserved
];

const PRIVATE_V6_CIDRS: ReadonlyArray<{ addr: string; bits: number }> = [
  { addr: "::", bits: 128 }, // unspecified
  { addr: "::1", bits: 128 }, // loopback
  { addr: "fc00::", bits: 7 }, // ULA
  { addr: "fe80::", bits: 10 }, // link-local
  { addr: "ff00::", bits: 8 }, // multicast
];

const blockList = (() => {
  const list = new net.BlockList();
  for (const c of PRIVATE_V4_CIDRS) list.addSubnet(c.addr, c.bits, "ipv4");
  for (const c of PRIVATE_V6_CIDRS) list.addSubnet(c.addr, c.bits, "ipv6");
  return list;
})();

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  return blockList.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Pre-flight URL validation. Run at config load and admin write so
 * misconfigurations fail fast with a clear message; the runtime
 * `lookup` hook below catches what slips past (DNS rebinding,
 * redirects).
 */
export async function assertSafeIssuerUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeIssuerError("issuer URL is not a valid URL", "invalid_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeIssuerError(
      `issuer URL protocol '${url.protocol}' is not http(s)`,
      "unsupported_protocol",
    );
  }

  if (url.protocol === "http:" && !isInsecureIssuerAllowed()) {
    throw new UnsafeIssuerError(
      `issuer URL must be https (set ${ALLOW_INSECURE_ENV}=1 to allow http for local development)`,
      "https_required",
    );
  }

  // Operator-set escape hatch: skip the private-address check too.
  // Used by docker-compose dev where Keycloak is on a private network.
  if (isInsecureIssuerAllowed()) return;

  const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
    dns.lookup(url.hostname, { all: true, family: 0 }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });

  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new UnsafeIssuerError(
        `issuer host '${url.hostname}' resolves to private address ${a.address}`,
        "private_address",
        a.address,
      );
    }
  }
}

/**
 * Custom DNS lookup hook. Called by the Node http(s) Agent every
 * time a socket is opened — including the second hop of an HTTP
 * redirect and a re-resolve after TTL expiry. Wraps the platform's
 * default lookup and rejects if any returned address is private.
 *
 * Wired into openid-client via `custom.setHttpOptionsDefaults` so it
 * applies to discovery, JWKS fetch, token exchange, and userinfo
 * uniformly.
 */
export const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  // The shared "openid-client" instance also issues requests via
  // `Issuer.discover` etc. before our pre-flight check runs (e.g.
  // testConnection on a partial config). The defense-in-depth check
  // here is the single point that ALL outbound requests must pass.
  const opts = typeof options === "object" ? options : { family: options };
  const handler: typeof callback = (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => {
    if (err) {
      // Pass through DNS errors (NXDOMAIN, ENOTFOUND etc.) — those
      // aren't an SSRF signal.
      // biome-ignore lint/suspicious/noExplicitAny: re-thread original signature
      (callback as any)(err, ...rest);
      return;
    }
    if (isInsecureIssuerAllowed()) {
      // biome-ignore lint/suspicious/noExplicitAny: re-thread original signature
      (callback as any)(null, ...rest);
      return;
    }
    // The DNS module's callback signature differs based on `all`:
    //   all=false -> (err, address, family)
    //   all=true  -> (err, addresses[])
    const wantAll = (opts as dns.LookupOptions).all === true;
    if (wantAll) {
      const addresses = rest[0] as dns.LookupAddress[];
      for (const a of addresses) {
        if (isPrivateAddress(a.address)) {
          callback(makeBlockedErr(hostname, a.address), [], 0);
          return;
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: re-thread original signature
      (callback as any)(null, addresses);
    } else {
      const address = rest[0] as string;
      const family = rest[1] as number;
      if (isPrivateAddress(address)) {
        callback(makeBlockedErr(hostname, address), "", 0);
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: re-thread original signature
      (callback as any)(null, address, family);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: dns.lookup overloads are tricky
  (dns.lookup as any)(hostname, opts, handler);
};

function makeBlockedErr(hostname: string, address: string): NodeJS.ErrnoException {
  const err = new Error(
    `SSRF guard blocked outbound request to ${hostname} (${address}): address is in a private range`,
  ) as NodeJS.ErrnoException;
  err.code = "EFLEET_SSRF_BLOCKED";
  return err;
}
