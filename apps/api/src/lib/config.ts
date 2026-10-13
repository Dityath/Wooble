type Env = Record<string, string | undefined>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

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
    if (env.TRUST_PROXY && env.TRUST_PROXY !== "true" && env.TRUST_PROXY !== "false")
      errors.push('TRUST_PROXY must be "true" or "false".');
  }
  const port = env.API_PORT;
  if (port && !(Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536))
    errors.push("API_PORT must be a port number between 1 and 65535.");
  return errors;
}
