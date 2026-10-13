import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addCanvasMember,
  authHeaders,
  MOD,
  registerUser,
  seedCanvas,
  shareCanvasByLink,
  signIn,
  type SeededCanvas,
  type TestUser,
} from "./helpers";

/**
 * Documentation of the shape a reader actually meets on a shared connection: prose with emphasis, a fenced code
 * block and a table. The read-only renderer must show all of it, and must not make any of it editable.
 */
const richDocumentation = [
  "## Retry policy",
  "",
  "Retries **twice** before failing. The payload is unchanged between attempts.",
  "",
  "```json",
  '{ "retries": 2, "backoffMs": 250 }',
  "```",
  "",
  "| Attempt | Wait before retry |",
  "| --- | --- |",
  "| 1 | 250 ms |",
  "| 2 | 500 ms |",
].join("\n");

let owner: TestUser;
let viewer: TestUser;
let seeded: SeededCanvas;
/** A second canvas of the same owner that is never link-shared, so the guest journeys can prove isolation. */
let privateCanvas: SeededCanvas;

test.beforeAll(async ({ request }) => {
  owner = await registerUser(request, "viewer-owner");
  viewer = await registerUser(request, "viewer-guest");
  seeded = await seedCanvas(request, owner.cookieValue);
  privateCanvas = await seedCanvas(request, owner.cookieValue);
  await addCanvasMember(request, owner.cookieValue, seeded.canvasId, viewer.email, "viewer");
  // Link sharing is what turns the canvas into a guest-readable surface; every other canvas stays private.
  await shareCanvasByLink(request, owner.cookieValue, seeded.canvasId);
  const documented = await request.patch(`/api/connections/${seeded.connectionId}`, {
    headers: authHeaders(owner.cookieValue),
    data: { metadata: { documentation: richDocumentation } },
  });
  if (!documented.ok()) throw new Error(`connection documentation failed: ${await documented.text()}`);
});

function openCanvas(page: Page) {
  return page.goto(`/canvases/${seeded.canvasId}`);
}

/**
 * Records what the page asks the server for. A reader journey must issue nothing but GETs, and the browser must run
 * without console errors, uncaught exceptions, failed requests, or failing API responses.
 *
 * `signedOut` allows the one failure a guest journey must expect: the app asks who it is, gets 401, and shows the
 * guest chrome. That probe is still recorded, so a journey can print it, but it is not treated as a problem.
 */
function watchBrowser(page: Page, { signedOut = false }: { signedOut?: boolean } = {}) {
  const writes: string[] = [];
  const problems: string[] = [];
  const expectedGuestProbe = (entry: string) => signedOut && /\/api\/auth\/me\b/.test(entry) && entry.includes("401");
  const path = (url: string) => new URL(url).pathname;
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(`${request.method()} ${path(request.url())}`);
  });
  page.on("response", (response) => {
    const entry = `HTTP ${response.status()} ${path(response.url())}`;
    if (response.status() >= 400 && path(response.url()).startsWith("/api/") && !expectedGuestProbe(entry))
      problems.push(entry);
  });
  page.on("requestfailed", (request) => {
    problems.push(`request failed: ${request.method()} ${path(request.url())} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("console", (message) => {
    // Chromium reports every failed subresource as a console error; the response watcher above records those with
    // their URL, so only messages that are not that network echo count here.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return { writes, problems };
}

/**
 * A click point on the edge's own path, in page coordinates: getScreenCTM is relative to the canvas viewport, so the
 * bounding rect contributes its offset inside the page. Candidates skip the middle of the line, where the edge label
 * is drawn on top of it, and elementFromPoint proves the point really hits this edge inside the window.
 */
const clickPointOnEdge = (edge: Locator) =>
  edge.evaluate((group) => {
    const path = group.querySelector(".react-flow__edge-path") as SVGPathElement | null;
    const matrix = path?.getScreenCTM();
    if (!path || !matrix) return null;
    const box = path.getBBox();
    const rect = path.getBoundingClientRect();
    const offsetX = rect.left - (matrix.a * box.x + matrix.c * box.y + matrix.e);
    const offsetY = rect.top - (matrix.b * box.x + matrix.d * box.y + matrix.f);
    for (const fraction of [0.2, 0.8, 0.35, 0.65, 0.1, 0.9]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction);
      const candidate = {
        x: point.x * matrix.a + point.y * matrix.c + matrix.e + offsetX,
        y: point.x * matrix.b + point.y * matrix.d + matrix.f + offsetY,
      };
      if (document.elementFromPoint(candidate.x, candidate.y)?.closest(".react-flow__edge") === group) return candidate;
    }
    return null;
  });

/** Waits until the animated viewport holds still twice in a row, so a measured click point stays valid. */
async function viewportSettled(page: Page) {
  const transform = () =>
    page.locator(".react-flow__viewport").evaluate((element) => (element as HTMLElement).style.transform);
  await page.waitForTimeout(400);
  let previous = await transform();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(120);
    const current = await transform();
    if (current === previous) return;
    previous = current;
  }
}

/**
 * Selects the seeded connection the way a reader does: fit the diagram into the window, then click the connector.
 * Both steps are retried because a fit animation can move the connector between measuring and clicking.
 */
async function selectConnection(page: Page, connectionId: string) {
  const edge = page.locator(`.react-flow__edge[data-id="${connectionId}"]`);
  const details = page.locator(".viewer-details");
  await expect(edge).toBeAttached();
  await expect(page.locator(`.react-flow__node[data-id="${seeded.alphaId}"]`)).toBeVisible();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByRole("button", { name: "Fit canvas" }).click();
    await viewportSettled(page);
    const point = await clickPointOnEdge(edge);
    if (!point) continue;
    await page.mouse.click(point.x, point.y);
    if (await details.isVisible()) return;
  }
  throw new Error("The connection edge could not be selected.");
}

/** Selects the seeded connection and returns its documentation region. */
async function openConnectionDocumentation(page: Page) {
  await selectConnection(page, seeded.connectionId);
  return page.getByRole("region", { name: "Connection documentation" });
}

/** Every reader must get the same rendered documentation: heading, emphasis, code block, table, and no editing. */
async function expectReadOnlyDocumentation(page: Page, browser: ReturnType<typeof watchBrowser>) {
  const documentation = await openConnectionDocumentation(page);
  await expect(documentation.getByRole("heading", { name: "Retry policy" })).toBeVisible();
  await expect(documentation.locator("strong")).toHaveText("twice");
  await expect(documentation.locator("pre code")).toContainText('"retries": 2');
  const table = documentation.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Attempt" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "500 ms" })).toBeVisible();
  await expect(documentation.getByRole("textbox")).toHaveCount(0);
  await expect(documentation.getByRole("button")).toHaveCount(0);
  await expect(documentation.locator("[contenteditable]")).toHaveCount(0);
  await expect(page.locator(".canvas-toolbox")).toHaveCount(0);
  await expect(page.locator(".inspector-panel")).toHaveCount(0);
  expect(browser.writes).toEqual([]);
  expect(browser.problems).toEqual([]);
}

test("viewer can inspect but cannot edit, delete, or undo", async ({ page }) => {
  const browser = watchBrowser(page);
  await signIn(await page.context(), viewer.cookieValue);
  await openCanvas(page);
  const alpha = page.locator(`.react-flow__node[data-id="${seeded.alphaId}"]`);
  await expect(alpha).toBeVisible();

  // Read-only surface: no editor toolbox at all.
  await expect(page.locator(".canvas-toolbox")).toHaveCount(0);
  await expect(page.locator(".viewer-label")).toContainText("Viewer access");

  await alpha.click();
  const details = page.locator(".viewer-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Alpha Service");
  await expect(details.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Open details" })).toBeVisible();
  await expect(alpha.evaluate((element) => getComputedStyle(element).cursor)).resolves.toBe("pointer");

  // Deletion keys and undo do nothing for a viewer: no dialog, node stays.
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(alpha).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(alpha).toBeVisible();
  await page.keyboard.press(`${MOD}+z`);
  await expect(alpha).toBeVisible();

  await page.reload();
  await expect(alpha).toBeVisible();
  expect(browser.writes).toEqual([]);
  expect(browser.problems).toEqual([]);
});

test("viewer reads connection documentation without editing it", async ({ page }) => {
  const browser = watchBrowser(page);
  await signIn(await page.context(), viewer.cookieValue);
  await openCanvas(page);
  await expect(page.locator(".viewer-label")).toContainText("Viewer access");
  await expectReadOnlyDocumentation(page, browser);
});

test("signed-out link guest reads connection documentation without editing it", async ({ page, context }) => {
  // A link guest is a browser context with no session cookie at all: the share link is the whole grant.
  expect(await context.cookies()).toEqual([]);
  const browser = watchBrowser(page, { signedOut: true });
  await openCanvas(page);

  await expect(page.locator(".viewer-label")).toContainText("Viewer access");
  // The signed-out chrome: a "Shared canvas" context with a sign-in link and no canvas management actions.
  await expect(page.getByRole("navigation", { name: "Current location" })).toContainText("Shared canvas");
  await expect(page.getByRole("link", { name: "Sign in to Wooble" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Wooble architecture library" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share canvas" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage canvas" })).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expectReadOnlyDocumentation(page, browser);

  // Editing gestures stay inert for a guest as they are for a viewer.
  await page.keyboard.press("Backspace");
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator(`.react-flow__node[data-id="${seeded.alphaId}"]`)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(browser.writes).toEqual([]);
  expect(browser.problems).toEqual([]);
});

test("a signed-out guest sees only the shared canvas graph", async ({ page, context }) => {
  expect(await context.cookies()).toEqual([]);
  // The guest's own reads go through the same API the page uses, with no cookie.
  const shared = await page.request.get(`/api/canvases/${seeded.canvasId}/graph`);
  expect(shared.ok()).toBe(true);
  const body = (await shared.json()) as { connections: Array<{ id: string }>; entities: unknown[] };
  expect(body.connections.map((connection) => connection.id)).toEqual([seeded.connectionId]);
  expect(JSON.stringify(body)).not.toContain(privateCanvas.connectionId);

  // The owner's other canvas is not link-shared, so an anonymous reader is refused: the API answers 401 "Sign in to
  // continue" rather than leaking whether the canvas exists.
  const denied = await page.request.get(`/api/canvases/${privateCanvas.canvasId}/graph`);
  expect(denied.status()).toBe(401);

  // And the rendered graph offers exactly the shared connection.
  const browser = watchBrowser(page, { signedOut: true });
  await openCanvas(page);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(`.react-flow__edge[data-id="${seeded.connectionId}"]`)).toBeAttached();
  await expect(page.locator(`.react-flow__edge[data-id="${privateCanvas.connectionId}"]`)).toHaveCount(0);
  expect(browser.writes).toEqual([]);
  expect(browser.problems).toEqual([]);
});
