import { describe, expect, it } from "bun:test";
import { isLocalHttpOrigin, parseWebOrigins, runtimeConfigErrors } from "../src/lib/config";

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
      expect(() => parseWebOrigins({ WEB_ORIGIN: entry })).toThrow(`WEB_ORIGIN entry "${entry}"`);
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
  it("accepts a complete production configuration", () => {
    expect(
      runtimeConfigErrors({ ...production, WEB_ORIGIN: "https://wooble.example.com", TRUST_PROXY: "true" }),
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
  });

  it("allows development without a database URL or proxy setting", () => {
    expect(runtimeConfigErrors({})).toEqual([]);
    expect(runtimeConfigErrors({ TRUST_PROXY: "yes" })).toEqual([]);
  });
});
