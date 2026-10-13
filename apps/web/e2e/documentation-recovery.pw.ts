import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Route } from "@playwright/test";
import {
  addCanvasMember,
  authHeaders,
  currentUserId,
  registerUser,
  seedCanvas,
  setCanvasMemberRole,
  signIn,
  signInWithForm,
  TEST_PASSWORD,
  type SeededCanvas,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let seeded: SeededCanvas;

test.beforeAll(async ({ request }) => {
  owner = await registerUser(request, "recovery-owner");
});

test.beforeEach(async ({ request, context, page }) => {
  // Time still flows; the clock is installed only so a journey can move it forward (see `ageAccessCache`).
  await page.clock.install();
  seeded = await seedCanvas(request, owner.cookieValue);
  await signIn(context, owner.cookieValue);
});

const node = (page: Page, entityId: string) => page.locator(`.react-flow__node[data-id="${entityId}"]`);
const edgeLabel = (page: Page) => page.locator(".architecture-edge-label").filter({ hasText: "REST" });
const detailsDialog = (page: Page) => page.getByRole("dialog", { name: "Canvas details" });
const documentationEditor = (page: Page) => detailsDialog(page).getByRole("textbox", { name: "Documentation" });
// The visual label shows every state; the hidden polite live region beside it only ever says "Saved".
const saveState = (page: Page) => detailsDialog(page).locator(".documentation-save-state");
const liveRegion = (page: Page) => detailsDialog(page).locator(".documentation-live");
const recoveryPrompt = (page: Page) =>
  detailsDialog(page).getByRole("status").filter({ hasText: "Unsaved documentation from" });
const failureNotice = (page: Page) => detailsDialog(page).getByRole("alert");
const closeConfirmation = (page: Page) => page.getByRole("alertdialog", { name: "Close with unsaved documentation?" });
const reloadButton = (page: Page) => detailsDialog(page).getByRole("button", { name: "Reload", exact: true });
const retryButton = (page: Page) => detailsDialog(page).getByRole("button", { name: "Retry", exact: true });

type Target = { kind: "entity" | "connection"; path: () => string };
const entityTarget: Target = { kind: "entity", path: () => `/api/entities/${seeded.alphaId}` };
const connectionTarget: Target = { kind: "connection", path: () => `/api/connections/${seeded.connectionId}` };

/** Failed requests the journey causes on purpose or expects from the server, as `watchBrowser` describes them. */
type Allowed = RegExp[];

/**
 * Records console errors, uncaught exceptions, failed requests and failing API responses. Anything not matched by
 * `allowed` is a problem. Each journey lists exactly the failures it provokes, so a surprise still fails the test.
 */
function watchBrowser(page: Page, allowed: Allowed = []) {
  const problems: string[] = [];
  const patches: string[] = [];
  const path = (url: string) => new URL(url).pathname;
  const record = (entry: string) => {
    if (!allowed.some((pattern) => pattern.test(entry))) problems.push(entry);
  };
  page.on("request", (request) => {
    if (request.method() === "PATCH") patches.push(path(request.url()));
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && path(response.url()).startsWith("/api/"))
      record(`HTTP ${response.status()} ${path(response.url())}`);
  });
  page.on("requestfailed", (request) => {
    record(`request failed: ${request.method()} ${path(request.url())} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("console", (message) => {
    // Chromium echoes each failed subresource as "Failed to load resource"; the response and requestfailed
    // watchers above record those with their URLs.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
      record(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => record(`pageerror: ${error.message}`));
  return { problems, patches };
}

/** A save the journey deliberately fails: PATCH of an entity or connection, aborted at the network. */
const abortedSave = /^request failed: PATCH \/api\/(entities|connections)\//;
const forbiddenSave = /^HTTP 403 \/api\/(entities|connections)\//;

/** Fails every documentation save at the network until the returned function is called. */
async function failSaves(page: Page) {
  const handler = (route: Route) => (route.request().method() === "PATCH" ? route.abort("failed") : route.fallback());
  await page.route(/\/api\/(entities|connections)\//, handler);
  return () => page.unroute(/\/api\/(entities|connections)\//, handler);
}

async function openCanvas(page: Page, canvasId = seeded.canvasId) {
  await page.goto(`/canvases/${canvasId}`);
  await expect(node(page, seeded.betaId)).toBeVisible();
  await expect(page.locator(".canvas-toolbox")).toBeVisible();
}

/**
 * Moves the page's clock past the query cache's 20 s `staleTime`, so that opening an object refetches the canvas access
 * the way it does for someone who has had the canvas open for a while. See the fixme journey below: without this, a
 * person who opens documentation within 20 s of loading the page gets no draft at all.
 */
const ageAccessCache = (page: Page) => page.clock.fastForward(21_000);

async function openTargetDocumentation(page: Page, target: Target, { ageCache = true } = {}) {
  if (ageCache) await ageAccessCache(page);
  if (target.kind === "entity") {
    await node(page, seeded.alphaId).click();
  } else {
    await page.keyboard.press("ControlOrMeta+e");
    await expect(page.locator(".canvas-tool-options")).toContainText("connector");
    await edgeLabel(page).click();
  }
  await page.locator(".inspector-panel").getByRole("button", { name: "Documentation", exact: true }).click();
  await expect(documentationEditor(page)).toBeVisible();
}

async function typeDocumentation(page: Page, text: string) {
  await documentationEditor(page).click();
  await page.keyboard.type(text);
}

async function draftKeys(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("wooble:draft:")));
}

async function stored(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  const { metadata } = (await response.json()) as { metadata: { documentation?: string | null } };
  return metadata.documentation ?? null;
}

/** Collects `beforeunload` prompts, accepting each so the navigation goes ahead. */
function watchBeforeUnload(page: Page) {
  const prompts: string[] = [];
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") prompts.push(dialog.type());
    void dialog.accept();
  });
  return prompts;
}

for (const target of [entityTarget, connectionTarget]) {
  test(`${target.kind}: text typed during a failed save survives a reload and is restored to the server`, async ({
    page,
  }) => {
    const browser = watchBrowser(page, [abortedSave]);
    const prompts = watchBeforeUnload(page);
    await openCanvas(page);
    await openTargetDocumentation(page, target);
    const unfail = await failSaves(page);

    await typeDocumentation(page, "Recovered after reload");
    await expect(saveState(page)).toHaveText("Save failed");
    await expect(liveRegion(page)).toHaveText("");
    await expect(retryButton(page)).toBeVisible();
    expect(await draftKeys(page)).toHaveLength(1);
    expect(await stored(page, target.path())).toBeNull();

    await page.reload();
    await expect(node(page, seeded.betaId)).toBeVisible();
    // The page asked before leaving, because the text was not saved.
    expect(prompts).toEqual(["beforeunload"]);
    await unfail();
    await openTargetDocumentation(page, target);
    await expect(recoveryPrompt(page)).toBeVisible();
    await expect(recoveryPrompt(page)).toContainText("Restore or discard it to keep editing.");
    // Offered, not applied: the editor is still empty, nothing was written, and it cannot be typed into meanwhile.
    await expect(documentationEditor(page)).toHaveText("");
    await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "false");

    await recoveryPrompt(page).getByRole("button", { name: "Restore" }).click();
    await expect(recoveryPrompt(page)).toHaveCount(0);
    await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "true");
    await expect(documentationEditor(page)).toBeFocused();
    await expect(documentationEditor(page)).toHaveText("Recovered after reload");
    await expect(saveState(page)).toHaveText("Saved");
    await expect(liveRegion(page)).toHaveText("Saved");
    await expect.poll(() => stored(page, target.path())).toBe("Recovered after reload");
    await expect.poll(() => draftKeys(page)).toEqual([]);
    expect(browser.problems).toEqual([]);
  });
}

// BUG: drafts are enabled only for a canvas-access result "fetched after mount", but the app's query cache has a 20 s
// staleTime and the page shell has already fetched that access on load. Opening documentation within 20 s of loading the
// page therefore reuses the cached result, `isFetchedAfterMount` never turns true, and the text is neither kept as a
// draft nor offered again. Confirmed by waiting 21 s (real time) before opening: the draft is then written and restored.
test.fixme("text typed within seconds of loading the page is kept as a draft when the save fails", async ({ page }) => {
  const browser = watchBrowser(page, [abortedSave]);
  watchBeforeUnload(page);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget, { ageCache: false });
  await failSaves(page);
  await typeDocumentation(page, "Typed right after load");
  await expect(saveState(page)).toHaveText("Save failed");
  expect(await draftKeys(page)).toHaveLength(1);
  expect(browser.problems).toEqual([]);
});

test("discarding a recovered draft removes it and leaves the server value alone", async ({ page, request }) => {
  const browser = watchBrowser(page, [abortedSave]);
  watchBeforeUnload(page);
  const original = await request.patch(entityTarget.path(), {
    headers: authHeaders(owner.cookieValue),
    data: { metadata: { documentation: "Server version" } },
  });
  expect(original.ok()).toBe(true);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await failSaves(page);
  await documentationEditor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Local rewrite that never saved");
  await expect(saveState(page)).toHaveText("Save failed");
  expect(await draftKeys(page)).toHaveLength(1);

  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await openTargetDocumentation(page, entityTarget);
  await expect(recoveryPrompt(page)).toBeVisible();
  await expect(documentationEditor(page)).toHaveText("Server version");
  await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "false");

  await recoveryPrompt(page).getByRole("button", { name: "Discard saved copy" }).click();
  await expect(recoveryPrompt(page)).toBeHidden();
  await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "true");
  await expect(documentationEditor(page)).toBeFocused();
  expect(await draftKeys(page)).toEqual([]);
  await expect(documentationEditor(page)).toHaveText("Server version");
  expect(await stored(page, entityTarget.path())).toBe("Server version");

  // Reopening finds nothing to offer.
  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  await openTargetDocumentation(page, entityTarget);
  await expect(documentationEditor(page)).toHaveText("Server version");
  await expect(recoveryPrompt(page)).toHaveCount(0);
  expect(await stored(page, entityTarget.path())).toBe("Server version");
  expect(browser.problems).toEqual([]);
});

test("beforeunload warns while documentation is unsaved and stays quiet once it is saved", async ({ page }) => {
  const browser = watchBrowser(page, [abortedSave]);
  const prompts = watchBeforeUnload(page);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);

  // Saved: leaving does not prompt.
  await typeDocumentation(page, "Saved text");
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(() => stored(page, entityTarget.path())).toBe("Saved text");
  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  expect(prompts).toEqual([]);

  // Failed save: leaving prompts.
  await openTargetDocumentation(page, entityTarget);
  const unfail = await failSaves(page);
  await documentationEditor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(saveState(page)).toHaveText("Save failed");
  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  expect(prompts).toEqual(["beforeunload"]);

  // Recover it, save it, and leave again: no further prompt.
  await unfail();
  await openTargetDocumentation(page, entityTarget);
  await recoveryPrompt(page).getByRole("button", { name: "Restore" }).click();
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(() => stored(page, entityTarget.path())).toContain("Saved text");
  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  expect(prompts).toEqual(["beforeunload"]);
  expect(browser.problems).toEqual([]);
});

test("closing the details dialog with unsaved documentation asks first, from every way to close", async ({ page }) => {
  const browser = watchBrowser(page, [abortedSave]);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  const dialog = detailsDialog(page);

  // Nothing typed: closing is immediate.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(closeConfirmation(page)).toHaveCount(0);

  await openTargetDocumentation(page, entityTarget);
  await failSaves(page);
  await typeDocumentation(page, "Not saved yet");
  await expect(saveState(page)).toHaveText("Save failed");

  const insideDetails = () => page.evaluate(() => !!document.activeElement?.closest(".canvas-details-dialog"));
  const keepEditing = async () => {
    await expect(closeConfirmation(page)).toBeVisible();
    await closeConfirmation(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(closeConfirmation(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect.poll(insideDetails).toBe(true);
    await expect(documentationEditor(page)).toHaveText("Not saved yet");
  };

  // The dialog's close button.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await keepEditing();

  // A click on the overlay outside the dialog.
  await page.mouse.click(4, 4);
  await keepEditing();

  // Escape leaves the editor first, and the Escape after it asks.
  await page.keyboard.press("Escape");
  await expect(documentationEditor(page)).not.toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(closeConfirmation(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await keepEditing();

  // Confirming closes the dialog; the text stays on the device.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(closeConfirmation(page)).toBeVisible();
  await closeConfirmation(page).getByRole("button", { name: "Close anyway" }).click();
  await expect(dialog).toBeHidden();
  await expect(closeConfirmation(page)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(1);
  expect(browser.problems).toEqual([]);
});

// BUG: after "Close anyway" the keyboard focus lands on <body>, not on the control that opened the details. Evidence: the
// opener is still in the page (one `.inspector-panel` "Documentation" button) but document.activeElement is BODY.
test.fixme("Close anyway returns focus to the control that opened the details", async ({ page }) => {
  const browser = watchBrowser(page, [abortedSave]);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await failSaves(page);
  await typeDocumentation(page, "Not saved yet");
  await expect(saveState(page)).toHaveText("Save failed");
  await detailsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await closeConfirmation(page).getByRole("button", { name: "Close anyway" }).click();
  await expect(detailsDialog(page)).toBeHidden();
  await expect(
    page.locator(".inspector-panel").getByRole("button", { name: "Documentation", exact: true }),
  ).toBeFocused();
  expect(browser.problems).toEqual([]);
});

test("closing after the documentation saved needs no confirmation", async ({ page }) => {
  const browser = watchBrowser(page);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await typeDocumentation(page, "Saved before closing");
  await expect(saveState(page)).toHaveText("Saved");
  await page.keyboard.press("Escape");
  await expect(documentationEditor(page)).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detailsDialog(page)).toBeHidden();
  await expect(closeConfirmation(page)).toHaveCount(0);
  expect(await stored(page, entityTarget.path())).toBe("Saved before closing");
  expect(browser.problems).toEqual([]);
});

test("a member whose editor access was revoked mid-edit keeps the visible text in a read-only editor and no draft", async ({
  page,
  request,
  context,
}) => {
  const member = await registerUser(request, "recovery-member");
  await addCanvasMember(request, owner.cookieValue, seeded.canvasId, member.email, "editor");
  const memberId = await currentUserId(request, member.cookieValue);
  await context.clearCookies();
  await signIn(context, member.cookieValue);
  const browser = watchBrowser(page, [forbiddenSave]);

  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await typeDocumentation(page, "First edit while an editor");
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(() => stored(page, entityTarget.path())).toBe("First edit while an editor");

  await setCanvasMemberRole(request, owner.cookieValue, seeded.canvasId, memberId, "viewer");
  await page.keyboard.type(" and an edit after the downgrade");

  const typed = "First edit while an editor and an edit after the downgrade";
  const notice = failureNotice(page);
  await expect(notice).toContainText("You can no longer edit this documentation");
  await expect(notice).toBeFocused();
  await expect(retryButton(page)).toHaveCount(0);
  // The text stays visible, but the editor is read-only.
  await expect(documentationEditor(page)).toBeVisible();
  await expect(documentationEditor(page)).toHaveText(typed);
  await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "false");
  await expect(saveState(page)).toHaveText("Not saved");
  expect(await draftKeys(page)).toEqual([]);
  expect(browser.problems).toEqual([]);
  // The server kept the last write that was allowed.
  expect(await stored(page, entityTarget.path())).toBe("First edit while an editor");

  // No further save is attempted, whatever the page does next.
  const patchesAtRevocation = browser.patches.length;
  await page.waitForTimeout(2000);
  expect(browser.patches.length).toBe(patchesAtRevocation);
  expect(await draftKeys(page)).toEqual([]);

  // Closing is immediate: nothing is unsaved any more.
  await page.keyboard.press("Escape");
  await expect(detailsDialog(page)).toBeHidden();
  await expect(closeConfirmation(page)).toHaveCount(0);
});

test("signing out purges drafts, and the next person on the browser is not offered them", async ({
  page,
  request,
  context,
}) => {
  // Signing out ends the server session, so this journey uses its own person instead of the shared owner.
  const first = await registerUser(request, "recovery-first");
  seeded = await seedCanvas(request, first.cookieValue);
  await context.clearCookies();
  await signIn(context, first.cookieValue);
  const other = await registerUser(request, "recovery-other");
  await addCanvasMember(request, first.cookieValue, seeded.canvasId, other.email, "editor");
  // After sign-out the app probes who it is and what it may open, and the server rightly answers 401 to both.
  const browser = watchBrowser(page, [
    abortedSave,
    /^HTTP 401 \/api\/auth\/me$/,
    /^HTTP 401 \/api\/canvases\/[^/]+\/access$/,
  ]);
  watchBeforeUnload(page);

  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await failSaves(page);
  await typeDocumentation(page, "Private notes of the first user");
  await expect(saveState(page)).toHaveText("Save failed");
  expect(await draftKeys(page)).toHaveLength(1);

  // The details dialog is modal; leave it (confirming) to reach the account menu.
  await detailsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await closeConfirmation(page).getByRole("button", { name: "Close anyway" }).click();
  await expect(detailsDialog(page)).toBeHidden();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => draftKeys(page)).toEqual([]);

  // A second person signs in on the same browser profile and opens the same documentation.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.clearCookies();
  await signIn(context, other.cookieValue);
  await openCanvas(page);
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.locator("#account-menu-panel")).toContainText(other.email);
  await page.keyboard.press("Escape");
  await openTargetDocumentation(page, entityTarget);
  await expect(documentationEditor(page)).toHaveText("");
  await expect(recoveryPrompt(page)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
  expect(browser.problems).toEqual([]);
});

test("a failed editor chunk shows readable Markdown with Reload, and Reload brings the editor back", async ({
  page,
  request,
}) => {
  const patch = await request.patch(entityTarget.path(), {
    headers: authHeaders(owner.cookieValue),
    data: { metadata: { documentation: "## Chunk fallback\n\nReadable **Markdown**." } },
  });
  expect(patch.ok()).toBe(true);
  const chunk = /rich-documentation-editor/;
  const failedChunks: string[] = [];
  const handler = (route: Route) => {
    failedChunks.push(route.request().url());
    return route.abort("failed");
  };
  await page.route(chunk, handler);
  // The aborted chunk request and React's logged dynamic-import error are the deliberate failures.
  const browser = watchBrowser(page, [
    /^request failed: GET .*rich-documentation-editor/,
    /^console: [\s\S]*Failed to fetch dynamically imported module/,
  ]);
  await openCanvas(page);
  await node(page, seeded.alphaId).click();
  await page.locator(".inspector-panel").getByRole("button", { name: "Documentation", exact: true }).click();

  const fallback = failureNotice(page);
  await expect(fallback).toContainText("The documentation editor could not load. Reload the page to try again.");
  await expect(fallback).toContainText("The documentation is shown below.");
  await expect(reloadButton(page)).toBeVisible();
  await expect(retryButton(page)).toHaveCount(0);
  expect(failedChunks.length).toBeGreaterThan(0);
  await expect(detailsDialog(page).getByRole("heading", { name: "Chunk fallback" })).toBeVisible();
  await expect(detailsDialog(page).locator("strong")).toHaveText("Markdown");
  await expect(documentationEditor(page)).toHaveCount(0);

  // The page around it still works.
  await page.keyboard.press("Escape");
  await expect(detailsDialog(page)).toBeHidden();
  await node(page, seeded.betaId).click();
  await expect(page.locator(".inspector-panel")).toContainText("Beta Service");

  // The chunk is reachable again; Reload loads the page afresh, and the editor works.
  await node(page, seeded.alphaId).click();
  await page.locator(".inspector-panel").getByRole("button", { name: "Documentation", exact: true }).click();
  await expect(reloadButton(page)).toBeVisible();
  await page.unroute(chunk, handler);
  const loaded = page.waitForEvent("load");
  await reloadButton(page).click();
  await loaded;
  await expect(node(page, seeded.betaId)).toBeVisible();
  await expect(detailsDialog(page)).toHaveCount(0);
  await openTargetDocumentation(page, entityTarget);
  await expect(documentationEditor(page).getByRole("heading", { name: "Chunk fallback" })).toBeVisible();
  await expect(documentationEditor(page)).toHaveAttribute("contenteditable", "true");
  await documentationEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Edited after reload.");
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(() => stored(page, entityTarget.path())).toContain("Edited after reload.");
  expect(browser.problems).toEqual([]);
});

// BUG: the editor never gets aria-invalid while over the limit. Evidence: with the notice showing "Remove 5 characters to
// save." the contenteditable has no aria-invalid, before and after further typing. The rich editor's setOptions call
// (rich-documentation-editor `invalid` -> documentation-editor.tsx) does not reach the DOM attribute.
test.fixme("documentation over the limit marks the editor aria-invalid, and clears it once under the limit", async ({
  page,
}) => {
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await documentationEditor(page).click();
  await documentationEditor(page).evaluate((element, pasted) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, "x".repeat(20_005));
  await expect(detailsDialog(page).getByText("Remove 5 characters to save.")).toBeVisible();
  await expect(documentationEditor(page)).toHaveAttribute("aria-invalid", "true");
  for (let removed = 0; removed < 5; removed += 1) await page.keyboard.press("Backspace");
  await expect(documentationEditor(page)).not.toHaveAttribute("aria-invalid", "true");
});

test("documentation over the limit says how much to remove, keeps the notice out of live regions, and sends nothing", async ({
  page,
}) => {
  const browser = watchBrowser(page);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await documentationEditor(page).click();
  await documentationEditor(page).evaluate((element, pasted) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, "x".repeat(20_005));

  // The sentence in the live region never changes; the exact excess is outside any live region.
  const limitNotice = detailsDialog(page).getByRole("status").filter({ hasText: "over the 20,000-character limit" });
  await expect(limitNotice).toHaveText("Documentation is over the 20,000-character limit.");
  const excess = detailsDialog(page).getByText("Remove 5 characters to save.");
  await expect(excess).toBeVisible();
  await expect(excess.locator("xpath=ancestor-or-self::*[@role='status' or @aria-live]")).toHaveCount(0);
  await expect(retryButton(page)).toHaveCount(0);
  await expect(failureNotice(page)).toHaveCount(0);
  await expect(saveState(page)).toHaveText("Unsaved changes");
  // The text is not lost: it is kept as a draft, and nothing was sent.
  expect(await draftKeys(page)).toHaveLength(1);
  await page.waitForTimeout(1500);
  expect(browser.patches).toEqual([]);
  expect(await stored(page, entityTarget.path())).toBeNull();

  // Removing the excess saves.
  for (let removed = 0; removed < 5; removed += 1) await page.keyboard.press("Backspace");
  await expect(limitNotice).toHaveCount(0);
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(async () => (await stored(page, entityTarget.path()))?.length).toBe(20_000);
  expect(browser.problems).toEqual([]);
});

/** Leaves the details dialog the way a person with unsaved text does: asks, then closes anyway. */
async function closeDetailsAnyway(page: Page) {
  await detailsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await closeConfirmation(page).getByRole("button", { name: "Close anyway" }).click();
  await expect(detailsDialog(page)).toBeHidden();
}

/** Registers a person of their own with a canvas and a failed-save draft on the entity, then closes the dialog. */
async function personWithFailedDraft(page: Page, request: APIRequestContext, context: BrowserContext, name: string) {
  const person = await registerUser(request, name);
  seeded = await seedCanvas(request, person.cookieValue);
  await context.clearCookies();
  await signIn(context, person.cookieValue);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await failSaves(page);
  await typeDocumentation(page, `Draft of ${name}`);
  await expect(saveState(page)).toHaveText("Save failed");
  expect(await draftKeys(page)).toHaveLength(1);
  await closeDetailsAnyway(page);
  return person;
}

const sessionProbes = /^HTTP 401 \/api\/(auth\/me|canvases\/[^/]+\/access)$/;

test("changing the password purges drafts, and signing in again is not offered them", async ({
  page,
  request,
  context,
}) => {
  const browser = watchBrowser(page, [abortedSave, sessionProbes]);
  watchBeforeUnload(page);
  const person = await personWithFailedDraft(page, request, context, "recovery-password");

  await page.goto("/profile");
  await page.getByRole("button", { name: "Change password" }).click();
  const newPassword = `${TEST_PASSWORD}-changed`;
  await page.locator("#profile-current-password").fill(TEST_PASSWORD);
  await page.locator("#profile-new-password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).last().click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => draftKeys(page)).toEqual([]);

  // The new password works, and the purge (not a different storage key) is why nothing is offered.
  await signInWithForm(page, person.email, newPassword);
  expect(await draftKeys(page)).toEqual([]);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await expect(documentationEditor(page)).toHaveText("");
  await expect(recoveryPrompt(page)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
  expect(browser.problems).toEqual([]);
});

test("signing out purges drafts, and the same person signing in again is not offered them", async ({
  page,
  request,
  context,
}) => {
  const browser = watchBrowser(page, [abortedSave, sessionProbes]);
  watchBeforeUnload(page);
  const person = await personWithFailedDraft(page, request, context, "recovery-same");

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(() => draftKeys(page)).toEqual([]);

  await signInWithForm(page, person.email, TEST_PASSWORD);
  expect(await draftKeys(page)).toEqual([]);
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);
  await expect(documentationEditor(page)).toHaveText("");
  await expect(recoveryPrompt(page)).toHaveCount(0);
  expect(await draftKeys(page)).toEqual([]);
  expect(browser.problems).toEqual([]);
});

test("leaving while a save is still in flight asks first, and nothing is offered after it lands", async ({ page }) => {
  const browser = watchBrowser(page);
  const prompts: string[] = [];
  page.on("dialog", (dialog) => {
    if (dialog.type() !== "beforeunload") return void dialog.accept();
    prompts.push(dialog.type());
    // Staying on the page: dismissing the prompt cancels the attempt to leave.
    void dialog.dismiss();
  });
  await openCanvas(page);
  await openTargetDocumentation(page, entityTarget);

  // Hold the save at the network: it has been sent and has not come back.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holdSave = async (route: Route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await held;
    return route.fallback();
  };
  await page.route(/\/api\/entities\//, holdSave);
  await typeDocumentation(page, "Saved while the page was open");
  // Leaving the editor saves at once; the request is now waiting on the held route.
  await page.keyboard.press("Escape");
  await expect(saveState(page)).toHaveText("Saving…");
  await expect.poll(() => browser.patches.length).toBe(1);

  await page.close({ runBeforeUnload: true });
  await expect.poll(() => prompts.length).toBe(1);
  expect(page.isClosed()).toBe(false);

  release();
  await expect(saveState(page)).toHaveText("Saved");
  await expect.poll(() => stored(page, entityTarget.path())).toBe("Saved while the page was open");
  await page.unroute(/\/api\/entities\//, holdSave);
  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  expect(prompts).toHaveLength(1);
  await openTargetDocumentation(page, entityTarget);
  await expect(recoveryPrompt(page)).toHaveCount(0);
  await expect(documentationEditor(page)).toHaveText("Saved while the page was open");
  expect(await draftKeys(page)).toEqual([]);
  expect(browser.problems).toEqual([]);
});
