import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const webRoot = resolve(import.meta.dir, "../apps/web");

function loadConfig(origin: string, ignoreHttpsErrors?: string) {
  const env = {
    ...process.env,
    SELFHOST_BROWSER_DISPOSABLE: "1",
    SELFHOST_BROWSER_ORIGIN: origin,
  };
  delete env.SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS;
  if (ignoreHttpsErrors) env.SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS = ignoreHttpsErrors;
  return spawnSync(process.execPath, ["-e", "await import('./playwright.selfhost.config.ts')"], {
    cwd: webRoot,
    encoding: "utf8",
    env,
  });
}

describe("self-host browser test config", () => {
  test("permits certificate bypass only for loopback disposable origins", () => {
    expect(loadConfig("https://localhost:18083", "1").status).toBe(0);
    expect(loadConfig("https://wooble.example.test", "1").stderr).toContain("only for a loopback disposable origin");
    expect(loadConfig("https://wooble.example.test").status).toBe(0);
  });
});
