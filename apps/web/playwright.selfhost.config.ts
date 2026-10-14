import { defineConfig } from "@playwright/test";

// Run with SELFHOST_BROWSER_DISPOSABLE=1 and SELFHOST_BROWSER_ORIGIN=https://<origin>.
// Set SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS=1 only for a disposable instance using
// Caddy's local certificate; cookies are still exercised by the browser over HTTPS.
const origin = process.env.SELFHOST_BROWSER_ORIGIN;
const disposable = process.env.SELFHOST_BROWSER_DISPOSABLE;
const ignoreHttpsErrors = process.env.SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS === "1";

if (disposable !== "1") {
  throw new Error("Set SELFHOST_BROWSER_DISPOSABLE=1 only for a disposable self-host instance.");
}
if (!origin) {
  throw new Error("Set SELFHOST_BROWSER_ORIGIN to the disposable self-host HTTPS origin.");
}

let baseURL: string;
let localOrigin = false;
try {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("origin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  localOrigin =
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  baseURL = parsed.origin;
} catch {
  throw new Error(
    "SELFHOST_BROWSER_ORIGIN must be a valid HTTPS origin without credentials, path, query, or fragment.",
  );
}
if (ignoreHttpsErrors && !localOrigin) {
  throw new Error("SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS=1 is allowed only for a loopback disposable origin.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "selfhost-install.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: ignoreHttpsErrors,
    trace: "off",
    screenshot: "off",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
});
