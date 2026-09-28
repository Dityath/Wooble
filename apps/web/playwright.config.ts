import { defineConfig } from "@playwright/test";

// Dedicated ports so the suite never collides with a running dev server.
// The web port must stay inside the API's development origin allowlist (5173-5179).
const API_PORT = process.env.BROWSER_TEST_API_PORT ?? "41311";
const WEB_PORT = process.env.BROWSER_TEST_WEB_PORT ?? "5177";
const TEST_DATABASE_URL = process.env.BROWSER_TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("Set BROWSER_TEST_DATABASE_URL to an isolated, migrated PostgreSQL test database.");
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
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "bun --env-file=../../.env src/index.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      cwd: "../api",
      env: { API_PORT, DATABASE_URL: TEST_DATABASE_URL },
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: `bun vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      env: { API_PORT },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
