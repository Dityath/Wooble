type Env = Record<string, string | undefined>;
import { isIP } from "node:net";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

/** Validates a comma-separated list of trusted proxy IPs/CIDRs and returns trimmed entries. */
export function parseTrustedProxyCidrs(value: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry))
    throw new ConfigError("TRUSTED_PROXY_CIDRS must be a comma-separated list of valid IP addresses or CIDRs.");
  for (const entry of entries) {
    const [address, prefix, ...extra] = entry.split("/");
    const family = isIP(address);
    if (
      !family ||
      extra.length > 0 ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new ConfigError("TRUSTED_PROXY_CIDRS entries must be valid IP addresses or CIDRs.");
  }
  return entries;
}

function ipNumber(address: string): { value: bigint; bits: number } | undefined {
  const family = isIP(address);
  if (family === 4) return { value: address.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n), bits: 32 };
  if (family !== 6) return undefined;
  let input = address.toLowerCase();
  const ipv4Tail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const octets = ipv4Tail[1].split(".").map(Number);
    input = `${input.slice(0, -ipv4Tail[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return { value: groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n), bits: 128 };
}

/** Returns whether an address belongs to one of the configured trusted proxy networks. */
export function isTrustedProxyAddress(address: string, cidrs: string[]): boolean {
  const candidate = ipNumber(address);
  if (!candidate) return false;
  return cidrs.some((cidr) => {
    const [networkAddress, rawPrefix] = cidr.split("/");
    const network = ipNumber(networkAddress);
    if (!network || network.bits !== candidate.bits) return false;
    const prefix = rawPrefix === undefined ? network.bits : Number(rawPrefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) return false;
    const shift = BigInt(network.bits - prefix);
    return candidate.value >> shift === network.value >> shift;
  });
}

/** Whether an origin is plain HTTP on this machine, where browsers accept a session cookie without Secure. */
export function isLocalHttpOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Reads WEB_ORIGIN, a comma-separated list of the exact browser origins allowed to use the API. Returns undefined when
 * it is unset outside production, so development can fall back to the local Vite ports.
 */
export function parseWebOrigins(env: Env): string[] | undefined {
  const production = env.NODE_ENV === "production";
  const entries = (env.WEB_ORIGIN ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) {
    if (production)
      throw new ConfigError(
        "WEB_ORIGIN must be set to the address people open in the browser, such as https://wooble.example.com.",
      );
    return undefined;
  }
  return entries.map((entry, index) => {
    const label = `WEB_ORIGIN entry ${index + 1}`;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`${label} is not a valid URL. Use an origin such as https://wooble.example.com.`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || entry.includes("*"))
      throw new ConfigError(`${label} must use http or https and must not contain wildcards.`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || entry.endsWith("/"))
      throw new ConfigError(
        `${label} must be an exact origin without credentials, a path, a query, a fragment, or a trailing slash.`,
      );
    if (production && url.protocol === "http:" && !loopbackHosts.has(url.hostname))
      throw new ConfigError(
        `${label} uses plain HTTP on an address other than this machine. Session cookies are Secure ` +
          "in production, so browsers would not keep the sign-in. Serve Wooble over HTTPS, or use a localhost address " +
          "through an SSH tunnel. See docs/self-hosting.md.",
      );
    return url.origin;
  });
}

/** Every configuration problem the API should refuse to start with. Messages name settings, never their values. */
export function runtimeConfigErrors(env: Env): string[] {
  const errors: string[] = [];
  try {
    parseWebOrigins(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    errors.push(error.message);
  }
  if (env.NODE_ENV === "production") {
    if (!env.DATABASE_URL) errors.push("DATABASE_URL must be set to the PostgreSQL connection for this installation.");
  }
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== "true" && env.TRUST_PROXY !== "false")
    errors.push('TRUST_PROXY must be "true" or "false".');
  if (env.TRUST_PROXY === "true" && !env.TRUSTED_PROXY_CIDRS?.trim())
    errors.push("TRUSTED_PROXY_CIDRS must be set to a nonempty trusted proxy allowlist when TRUST_PROXY is true.");
  if (env.TRUSTED_PROXY_CIDRS !== undefined) {
    try {
      parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      errors.push(error.message);
    }
  }
  const port = env.API_PORT;
  if (
    port !== undefined &&
    !(/^\d+$/.test(port) && Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536)
  )
    errors.push("API_PORT must be a port number between 1 and 65535.");
  return errors;
}
