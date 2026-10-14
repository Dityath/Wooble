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

// Lists the tests Playwright would run for a config without launching a browser
// or touching a database. The database URL is a non-routable placeholder.
function listSpecFiles(configFile: string, extraEnv: Record<string, string>): Set<string> {
  const env = {
    ...process.env,
    BROWSER_TEST_DATABASE_URL: "postgres://placeholder:placeholder@127.0.0.1:1/browser_journeys_placeholder",
    ...extraEnv,
  };
  delete env.SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS;
  const result = spawnSync(
    process.execPath,
    [resolve(webRoot, "node_modules/@playwright/test/cli.js"), "test", "--list", "-c", configFile],
    { cwd: webRoot, encoding: "utf8", env },
  );
  expect(result.status, result.stderr).toBe(0);
  const files = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s+(\S+\.pw\.ts):\d+:\d+ › /.exec(line);
    if (match?.[1]) files.add(match[1]);
  }
  return files;
}

describe("self-host browser test config", () => {
  test("permits certificate bypass only for loopback disposable origins", () => {
    expect(loadConfig("https://localhost:18083", "1").status).toBe(0);
    expect(loadConfig("https://wooble.example.test", "1").stderr).toContain("only for a loopback disposable origin");
    expect(loadConfig("https://wooble.example.test").status).toBe(0);
  });

  test("canvas browser config excludes the self-host journey", () => {
    const files = listSpecFiles("playwright.config.ts", {});
    expect(files.has("selfhost-install.pw.ts")).toBe(false);
    expect(files.has("canvas-editor.pw.ts")).toBe(true);
    expect(files.has("canvas-viewer.pw.ts")).toBe(true);
  });

  test("self-host browser config runs only the self-host journey", () => {
    const files = listSpecFiles("playwright.selfhost.config.ts", {
      SELFHOST_BROWSER_DISPOSABLE: "1",
      SELFHOST_BROWSER_ORIGIN: "https://wooble.example.test",
    });
    expect([...files]).toEqual(["selfhost-install.pw.ts"]);
  });
});
