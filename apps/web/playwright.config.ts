import { defineConfig } from "@playwright/test";

// Dedicated ports so the suite never collides with a running dev server. The default web port also sits inside the
// API's development origin allowlist (5173-5179); any port works because WEB_ORIGIN is set explicitly below.
const API_PORT = process.env.BROWSER_TEST_API_PORT ?? "41311";
const WEB_PORT = process.env.BROWSER_TEST_WEB_PORT ?? "5177";
const TEST_DATABASE_URL = process.env.BROWSER_TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("Set BROWSER_TEST_DATABASE_URL to an isolated, migrated PostgreSQL test database.");
}

// The journeys register people and write canvases, so they must never run against the database `.env.example`
// documents for development. Refused here because Bun loads a developer's `.env` before this file is imported,
// which would otherwise let an exported `BROWSER_TEST_DATABASE_URL` quietly target working data.
const DEVELOPMENT_DATABASE = "architecture_canvas";
const testDatabase = new URL(TEST_DATABASE_URL);
if (
  testDatabase.pathname.slice(1) === DEVELOPMENT_DATABASE &&
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(testDatabase.hostname)
) {
  throw new Error(
    `BROWSER_TEST_DATABASE_URL must not be the development database ${DEVELOPMENT_DATABASE}; point it at a disposable database.`,
  );
}

export default defineConfig({
  // Named *.pw.ts so `bun test` never collects them; bun's path filters and
  // its *.spec.* discovery would otherwise run Playwright suites as bun tests.
  testDir: "./e2e",
  testMatch: "*.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // CI keeps an HTML report to upload when a journey fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Lets a machine with its own Chromium build run the journeys without downloading Playwright's pinned one.
    ...(process.env.BROWSER_TEST_CHROMIUM
      ? { launchOptions: { executablePath: process.env.BROWSER_TEST_CHROMIUM } }
      : {}),
  },
  webServer: [
    {
      // No .env file is loaded, so a developer's settings can never point the journeys at their working database.
      // The attempt limit is raised because the journeys register and sign in many people from one address.
      command: "bun --no-env-file src/index.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      cwd: "../api",
      env: {
        API_PORT,
        DATABASE_URL: TEST_DATABASE_URL,
        WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        NODE_ENV: "test",
        AUTH_ATTEMPT_LIMIT: "1000",
      },
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      // `--no-env-file` keeps a developer's `.env` out of the web server, and VITE_API_URL is pinned empty so the app
      // keeps using the proxy below instead of an absolute URL that would point the journeys at a running dev API.
      command: `bun --no-env-file vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      env: { API_PORT, VITE_API_URL: "" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
