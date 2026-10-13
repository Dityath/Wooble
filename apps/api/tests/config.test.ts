import { describe, expect, it } from "bun:test";
import {
  isLocalHttpOrigin,
  isTrustedProxyAddress,
  parseTrustedProxyCidrs,
  parseWebOrigins,
  runtimeConfigErrors,
} from "../src/lib/config";

const production = { NODE_ENV: "production", DATABASE_URL: "postgres://wooble:secret-value@db:5432/wooble" };

describe("WEB_ORIGIN", () => {
  it("falls back to the development ports only outside production", () => {
    expect(parseWebOrigins({})).toBeUndefined();
    expect(parseWebOrigins({ WEB_ORIGIN: " , " })).toBeUndefined();
    expect(() => parseWebOrigins({ NODE_ENV: "production" })).toThrow("WEB_ORIGIN must be set");
  });

  it("normalises exact origins and accepts several", () => {
    expect(parseWebOrigins({ WEB_ORIGIN: "https://Wooble.Example.com:443, http://localhost:8080" })).toEqual([
      "https://wooble.example.com",
      "http://localhost:8080",
    ]);
  });

  it("rejects paths, queries, fragments, trailing slashes, credentials, wildcards, and other schemes", () => {
    for (const entry of [
      "https://wooble.example.com/",
      "https://wooble.example.com/app",
      "https://wooble.example.com?x=1",
      "https://wooble.example.com#top",
      "https://user:pass@wooble.example.com",
      "https://*.example.com",
      "ftp://wooble.example.com",
      "wooble.example.com",
    ])
      expect(() => parseWebOrigins({ WEB_ORIGIN: entry })).toThrow("WEB_ORIGIN entry 1");
  });

  it("redacts rejected origins and embedded secrets while identifying the entry and reason", () => {
    const cases = [
      { origin: "https://bad-secret.example.com:invalid", secret: "bad-secret", reason: "not a valid URL" },
      { origin: "https://user:password-token@wooble.example.com", secret: "password-token", reason: "credentials" },
      { origin: "https://wooble.example.com?token=query-token", secret: "query-token", reason: "query" },
      { origin: "https://wooble.example.com#token=fragment-token", secret: "fragment-token", reason: "fragment" },
    ];

    for (const { origin, secret, reason } of cases) {
      let message = "";
      try {
        parseWebOrigins({ WEB_ORIGIN: `https://valid.example.com,${origin}` });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("WEB_ORIGIN");
      expect(message).toContain("entry 2");
      expect(message).toContain(reason);
      expect(message).not.toContain(origin);
      expect(message).not.toContain(secret);
    }
  });

  it("refuses plain HTTP on another machine in production, where sign-in cookies are Secure", () => {
    expect(() => parseWebOrigins({ ...production, WEB_ORIGIN: "http://192.0.2.10:8080" })).toThrow(
      "Serve Wooble over HTTPS",
    );
    expect(parseWebOrigins({ WEB_ORIGIN: "http://192.0.2.10:8080" })).toEqual(["http://192.0.2.10:8080"]);
    for (const local of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"])
      expect(parseWebOrigins({ ...production, WEB_ORIGIN: local })).toEqual([local]);
  });

  it("recognises local HTTP origins", () => {
    expect(isLocalHttpOrigin("http://localhost:8080")).toBe(true);
    expect(isLocalHttpOrigin("http://[::1]:8080")).toBe(true);
    expect(isLocalHttpOrigin("https://localhost:8080")).toBe(false);
    expect(isLocalHttpOrigin("http://192.0.2.10")).toBe(false);
    expect(isLocalHttpOrigin("not a url")).toBe(false);
  });
});

describe("runtime configuration", () => {
  it("validates explicit trusted proxy CIDRs and matches IPv4 and IPv6 networks", () => {
    expect(parseTrustedProxyCidrs(" 172.30.0.2/32, 2001:db8::/32 ")).toEqual(["172.30.0.2/32", "2001:db8::/32"]);
    expect(isTrustedProxyAddress("172.30.0.2", ["172.30.0.2/32"])).toBe(true);
    expect(isTrustedProxyAddress("172.30.0.3", ["172.30.0.2/32"])).toBe(false);
    expect(isTrustedProxyAddress("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    for (const invalid of ["", "172.30.0.2/33", "2001:db8::/129", "not-an-ip", "172.30.0.2,,10.0.0.1"])
      expect(() => parseTrustedProxyCidrs(invalid)).toThrow("TRUSTED_PROXY_CIDRS");
  });

  it("accepts a complete production configuration", () => {
    expect(
      runtimeConfigErrors({
        ...production,
        WEB_ORIGIN: "https://wooble.example.com",
        TRUST_PROXY: "true",
        TRUSTED_PROXY_CIDRS: "172.30.0.2/32",
      }),
    ).toEqual([]);
    expect(
      runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", TRUST_PROXY: "false" }),
    ).toEqual([]);
  });

  it("reports every problem at once without printing values", () => {
    const errors = runtimeConfigErrors({ NODE_ENV: "production", TRUST_PROXY: "yes", API_PORT: "80000" });
    expect(errors).toEqual([
      expect.stringContaining("WEB_ORIGIN must be set"),
      expect.stringContaining("DATABASE_URL must be set"),
      'TRUST_PROXY must be "true" or "false".',
      "API_PORT must be a port number between 1 and 65535.",
    ]);
    const withSecret = runtimeConfigErrors({ ...production, WEB_ORIGIN: "http://192.0.2.10:8080" });
    expect(withSecret.join("\n")).not.toContain("secret-value");
    expect(withSecret.join("\n")).toContain("WEB_ORIGIN entry 1");
    expect(withSecret.join("\n")).toContain("plain HTTP");
  });

  it("keeps production startup guards for missing settings and invalid values", () => {
    expect(runtimeConfigErrors({ NODE_ENV: "production" })).toEqual([
      expect.stringContaining("WEB_ORIGIN must be set"),
      expect.stringContaining("DATABASE_URL must be set"),
    ]);
    expect(
      runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", TRUST_PROXY: "yes" }),
    ).toEqual(['TRUST_PROXY must be "true" or "false".']);
    expect(
      runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", TRUST_PROXY: "true" }),
    ).toEqual(["TRUSTED_PROXY_CIDRS must be set to a nonempty trusted proxy allowlist when TRUST_PROXY is true."]);
    expect(
      runtimeConfigErrors({
        ...production,
        WEB_ORIGIN: "https://wooble.example.com",
        TRUST_PROXY: "true",
        TRUSTED_PROXY_CIDRS: "172.30.0.2/33",
      }),
    ).toEqual(["TRUSTED_PROXY_CIDRS entries must be valid IP addresses or CIDRs."]);
    expect(runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", API_PORT: "65536" })).toEqual(
      ["API_PORT must be a port number between 1 and 65535."],
    );
    for (const API_PORT of ["", "  ", "abc", "80abc", "0", "65536"])
      expect(runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", API_PORT })).toContain(
        "API_PORT must be a port number between 1 and 65535.",
      );
  });

  it("allows development without a database URL or proxy setting", () => {
    expect(runtimeConfigErrors({})).toEqual([]);
    expect(runtimeConfigErrors({ TRUST_PROXY: "false" })).toEqual([]);
    expect(runtimeConfigErrors({ TRUST_PROXY: "yes" })).toEqual(['TRUST_PROXY must be "true" or "false".']);
    expect(runtimeConfigErrors({ TRUST_PROXY: "true", TRUSTED_PROXY_CIDRS: "172.30.0.2/33" })).toEqual([
      "TRUSTED_PROXY_CIDRS entries must be valid IP addresses or CIDRs.",
    ]);
  });
});
