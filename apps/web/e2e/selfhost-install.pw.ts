import { expect, test } from "@playwright/test";

const password = "WoobleSelfhostBrowser-2026!";

test("serves the web app and supports registration, sign out, and login over HTTPS", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("SELFHOST_BROWSER_ORIGIN must be configured by playwright.selfhost.config.ts.");
  const origin = new URL(baseURL);
  const staticResponses: Array<{ pathname: string; status: number; contentType: string }> = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin.origin && /\.(?:js|css|svg)(?:$|\?)/.test(url.pathname)) {
      staticResponses.push({
        pathname: url.pathname,
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
    }
  });

  const documentResponse = await page.goto("/");
  expect(documentResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.locator('img[src="/wooble-mark.svg"]')).toBeVisible();
  await expect.poll(() => staticResponses.some((response) => response.pathname.endsWith(".js"))).toBe(true);
  await expect.poll(() => staticResponses.some((response) => response.pathname.endsWith(".css"))).toBe(true);
  expect(staticResponses.length).toBeGreaterThanOrEqual(2);
  expect(staticResponses.every((response) => response.status === 200)).toBe(true);
  expect(
    staticResponses.some(
      (response) => response.pathname.endsWith(".js") && response.contentType.includes("javascript"),
    ),
  ).toBe(true);
  expect(
    staticResponses.some((response) => response.pathname.endsWith(".css") && response.contentType.includes("text/css")),
  ).toBe(true);

  const email = `selfhost-${crypto.randomUUID()}@example.test`;
  await page.getByRole("link", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Full name").fill("Disposable Self-host Browser");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/canvases(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();

  const session = (await page.context().cookies(origin.origin)).find((cookie) => cookie.name === "wooble_session");
  expect(session, "registration should set the browser session cookie").toBeDefined();
  expect(session?.secure, "self-host session cookie must remain Secure over HTTPS").toBe(true);
  expect(session?.httpOnly, "session cookie must remain HttpOnly").toBe(true);

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect((await page.context().cookies(origin.origin)).some((cookie) => cookie.name === "wooble_session")).toBe(false);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/canvases(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
});
