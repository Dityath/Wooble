import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  authHeaders,
  MOD,
  MOD_SYMBOL,
  registerUser,
  seedCanvas,
  signIn,
  type SeededCanvas,
  type TestUser,
} from "./helpers";
// The chip the canvas renders and the box the layout reserves for it come from the same cap.
import { EDGE_LABEL_MAX_WIDTH } from "../src/features/canvas/edge-label";

const TOOL_NAMES = ["Select", "Hand", "Add node", "Connector", "System box", "Edit connector"] as const;

let owner: TestUser;
let seeded: SeededCanvas;

test.beforeAll(async ({ request }) => {
  owner = await registerUser(request, "owner");
});

test.beforeEach(async ({ request }) => {
  seeded = await seedCanvas(request, owner.cookieValue);
});

function openCanvas(page: Page) {
  return page.goto(`/canvases/${seeded.canvasId}`);
}

function node(page: Page, entityId: string) {
  return page.locator(`.react-flow__node[data-id="${entityId}"]`);
}

function toolButton(page: Page, name: string) {
  return page.locator(".canvas-toolbox").getByRole("button", { name, exact: true });
}

const edgeLabel = (page: Page) => page.locator(".architecture-edge-label").filter({ hasText: "REST" });

// Radix ignores a single teleporting mousemove when closing the open tooltip
// in headless; a stepped pointer move reliably fires the leave transition.
async function showTooltip(page: Page, name: string) {
  await page.mouse.move(20, 20, { steps: 8 });
  const tooltip = page.getByRole("tooltip");
  if (await tooltip.isVisible().catch(() => false)) await tooltip.waitFor({ state: "hidden" });
  await toolButton(page, name).hover();
  await expect(tooltip).toBeVisible();
  return tooltip;
}

async function openCanvasAsEditor(page: Page) {
  await openCanvas(page);
  await awaitEditorReady(page);
}

// The editor attaches its global key handlers in a post-commit effect; wait
// for the mounted surface before any keyboard interaction.
async function awaitEditorReady(page: Page) {
  await expect(node(page, seeded.betaId)).toBeVisible();
  await expect(page.locator(".canvas-toolbox")).toBeVisible();
}

async function switchToolByKeyboard(page: Page, key: string, hint: string) {
  await page.keyboard.press(`${MOD}+${key}`);
  await expect(page.locator(".canvas-tool-options")).toContainText(hint);
}

async function expectCursor(locator: Locator, cursor: string) {
  await expect.poll(() => locator.evaluate((element) => getComputedStyle(element).cursor)).toBe(cursor);
}

test("toolbar tooltips advertise the platform shortcut beside each tool name", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);

  const selectTooltip = await showTooltip(page, "Select");
  await expect(selectTooltip).toContainText("Select");
  await expect(selectTooltip).toContainText(`${MOD_SYMBOL}S`);

  await expect(await showTooltip(page, "Hand")).toContainText(`Hand${MOD_SYMBOL}H`);

  await expect(await showTooltip(page, "Edit connector")).toContainText(`${MOD_SYMBOL}E`);

  // Auto Neat and Zen mode have no keyboard shortcut and must not advertise one.
  for (const label of ["Auto Neat", "Zen mode"]) {
    await expect(await showTooltip(page, label)).toHaveText(label);
  }
});

test("keyboard switches tools and is refused while Auto Neat is busy, like the mouse", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);

  await page.keyboard.press(`${MOD}+n`);
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "true");

  // Auto Neat shows its busy state before it reloads the graph and only then sends this request, so the assertions
  // below can pass before it is sent. Wait for the held request itself instead of checking for it once.
  let hold!: (route: Route) => void;
  const held = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  await page.route("**/api/canvases/*/auto-neat", (route) => hold(route));
  await toolButton(page, "Auto Neat").click();
  await expect(page.locator(".canvas-auto-neat-status")).toContainText("Tidying canvas…");
  for (const name of TOOL_NAMES) await expect(toolButton(page, name)).toBeDisabled();

  // Keyboard switching is swallowed while busy…
  await page.keyboard.press(`${MOD}+s`);
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "false");
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "true");
  // …and the disabled buttons ignore mouse clicks on the same state.
  await expect(toolButton(page, "Select")).toBeDisabled();

  await (await held).abort();
  await expect(toolButton(page, "Auto Neat")).toBeEnabled();
  await expect(page.locator(".canvas-auto-neat-status")).not.toContainText("Tidying canvas…");

  await page.keyboard.press(`${MOD}+s`);
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "false");
});

test("Backspace on a selected node opens the confirmed dialog and Cancel keeps the node", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  const alpha = node(page, seeded.alphaId);
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(page.locator(".inspector-panel")).toContainText("Alpha Service");

  await page.keyboard.press("Backspace");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete Alpha Service?");
  // No transient local-only removal: the node stays until the dialog is confirmed.
  await expect(alpha).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(alpha).toBeVisible();

  await page.reload();
  await expect(alpha).toBeVisible();
});

test("Backspace then confirm deletes through the API: Activity records it, reload keeps it, Undo restores", async ({
  page,
}) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  const alpha = node(page, seeded.alphaId);
  await alpha.click();
  await page.keyboard.press("Backspace");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(alpha).toBeHidden();

  await page.getByRole("button", { name: "Toggle activity log" }).click();
  const activity = page.locator(".canvas-activity-log");
  await expect(activity).toContainText("deleted");
  await expect(activity).toContainText("Alpha Service");
  // Undo is discoverable in the activity sidebar with the platform shortcut.
  await expect(activity.locator(".canvas-activity-hint")).toHaveText(`${MOD_SYMBOL}Z undoes the last change`);

  // The keyboard deletion is persisted: a reload does not bring the node back.
  await page.reload();
  await awaitEditorReady(page);

  await page.keyboard.press(`${MOD}+z`);
  await expect(alpha).toBeVisible();
  await expect(page.locator(".inspector-panel")).toBeHidden();
});

test("Delete on a selected connector follows the same confirmed path and is undoable", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await expect(edgeLabel(page)).toBeVisible();

  await switchToolByKeyboard(page, "e", "connector");
  await edgeLabel(page).click();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog");
  // The dialog title falls back to "item" for unlabeled connections; the
  // description still identifies it as a connection.
  await expect(dialog).toContainText("Delete item?");
  await expect(dialog).toContainText("This removes the connection from this canvas.");
  await expect(edgeLabel(page)).toBeVisible();

  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(edgeLabel(page)).toBeHidden();

  await page.reload();
  await awaitEditorReady(page);
  await expect(edgeLabel(page)).toBeHidden();

  await page.keyboard.press(`${MOD}+z`);
  await expect(edgeLabel(page)).toBeVisible();
});

test("typing keys stay inside inspector inputs and never switch tools or delete", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await node(page, seeded.alphaId).click();
  await page.getByRole("button", { name: "Edit in sidebar" }).click();
  await page.getByRole("button", { name: "Edit name" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Alpha Service");

  // "n" would switch to Add node if the interactive-target guard broke;
  // "s" alone could not distinguish Select→Select.
  await page.keyboard.press("n");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveValue("Alpha Servicen");
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(input).toHaveValue("Alpha Service");

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(edgeLabel(page)).toBeVisible();
});

test("Delete and Backspace on a focused connector bend point remove only that point", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await switchToolByKeyboard(page, "e", "connector");
  await edgeLabel(page).click();

  const hitbox = page.getByRole("button", { name: "Add connector point" });
  // Selection makes the connector-shaped hitbox keyboard-activatable.
  await expect(hitbox).toHaveAttribute("tabindex", "0");
  await hitbox.focus();
  await page.keyboard.press("Enter");
  const firstPoint = page.getByRole("button", { name: /Connector point 1/ });
  await expect(firstPoint).toBeVisible();

  await firstPoint.focus();
  await expect(firstPoint).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(firstPoint).toBeHidden();
  await expect(edgeLabel(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await hitbox.focus();
  await page.keyboard.press("Enter");
  const secondPoint = page.getByRole("button", { name: /Connector point 1/ });
  await expect(secondPoint).toBeVisible();
  await secondPoint.focus();
  // The graph refresh that follows every save must leave this handle alone; losing it made the following Backspace
  // fall through to the canvas shortcut, which asked to delete the whole connector instead of one point.
  await expect(secondPoint).toBeFocused();
  await page.keyboard.press("Backspace");
  await expect(secondPoint).toBeHidden();
  await expect(edgeLabel(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The connector itself survives: reload still shows it.
  await page.reload();
  await awaitEditorReady(page);
  await expect(edgeLabel(page)).toBeVisible();
});

test("a connector save in flight keeps its bend point focused, so Delete never opens the connector dialog", async ({
  page,
}) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await switchToolByKeyboard(page, "e", "connector");
  await edgeLabel(page).click();

  // Hold the save open so the graph refresh lands while the point is still being edited.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  let saves = 0;
  await page.route("**/connections/*/bend", async (route) => {
    if (holding) await held;
    saves += 1;
    await route.continue();
  });

  const hitbox = page.getByRole("button", { name: "Add connector point" });
  await expect(hitbox).toHaveAttribute("tabindex", "0");
  await hitbox.focus();
  await page.keyboard.press("Enter");
  const point = page.getByRole("button", { name: /Connector point 1/ });
  await expect(point).toBeVisible();
  await point.focus();
  await expect(point).toBeFocused();

  // The save is still open: nothing may have moved the point or the focus away.
  await page.waitForTimeout(500);
  await expect(point).toBeFocused();
  expect(saves).toBe(0);

  holding = false;
  release();
  await page.waitForResponse(
    (response) => response.url().includes("/connections/") && response.url().endsWith("/bend"),
  );
  await expect(page.getByRole("button", { name: /Connector point 1/ })).toBeFocused();

  await page.keyboard.press("Delete");
  await expect(page.getByRole("button", { name: /Connector point 1/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(edgeLabel(page)).toBeVisible();
});

test("adding and removing connector points faster than the saves keeps the route consistent", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await switchToolByKeyboard(page, "e", "connector");
  await edgeLabel(page).click();

  const point = (name: string | RegExp) => page.getByRole("button", { name });
  const handles = () => point(/Connector point/);
  const hitbox = point("Add connector point");
  await expect(hitbox).toHaveAttribute("tabindex", "0");

  // Three adds in a row, each one pressed before the previous save can come back. Every edit has to build on the
  // route the one before it produced, so the canvas ends up with all three points.
  for (let added = 1; added <= 3; added += 1) {
    await hitbox.focus();
    await page.keyboard.press("Enter");
    await expect(point(`Connector point ${added}`)).toBeVisible();
  }
  await expect(handles()).toHaveCount(3);

  // And three removes in a row, each aimed at the last remaining point.
  for (let remaining = 2; remaining >= 0; remaining -= 1) {
    const last = point(`Connector point ${remaining + 1}`);
    await expect(last).toBeVisible();
    await last.focus();
    await expect(last).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(handles()).toHaveCount(remaining);
  }
  // Nothing along the way was mistaken for the connector itself, so no confirmed delete was ever asked for.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(edgeLabel(page)).toBeVisible();

  // The queued saves settle on the route the canvas ended up showing.
  await page.reload();
  await awaitEditorReady(page);
  await switchToolByKeyboard(page, "e", "connector");
  await edgeLabel(page).click();
  await expect(edgeLabel(page)).toBeVisible();
  await expect(handles()).toHaveCount(0);
});

// The same edit on a slow machine: everything between a keystroke and the next render takes longer, which is where a
// connector that is rebuilt instead of updated loses the point the keyboard is aimed at.
test("editing connector points on a slow machine never falls back to deleting the connector", async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  try {
    await switchToolByKeyboard(page, "e", "connector");
    await edgeLabel(page).click();

    const point = (name: string | RegExp) => page.getByRole("button", { name });
    const handles = () => point(/Connector point/);
    const hitbox = point("Add connector point");
    await expect(hitbox).toHaveAttribute("tabindex", "0");

    for (let added = 1; added <= 2; added += 1) {
      await hitbox.focus();
      await page.keyboard.press("Enter");
      await expect(point(`Connector point ${added}`)).toBeVisible();
    }
    for (let remaining = 1; remaining >= 0; remaining -= 1) {
      const last = point(`Connector point ${remaining + 1}`);
      await expect(last).toBeVisible();
      await last.focus();
      await expect(last).toBeFocused();
      await page.keyboard.press("Backspace");
      await expect(handles()).toHaveCount(remaining);
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(edgeLabel(page)).toBeVisible();
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
  }
});

// A connection name can be up to 100 characters, so the label chip is wider than any fixed box Auto Neat could
// assume. It has to stay inside the width the layout reserved for it, or label collisions come back.
test("a long connection label stays inside the width Auto Neat reserved for it", async ({ page, request }) => {
  await signIn(await page.context(), owner.cookieValue);
  const headers = authHeaders(owner.cookieValue);
  const name = "Nightly reconciliation export to the regional warehouse and its audit trail";
  const renamed = await request.patch(`/api/connections/${seeded.connectionId}`, { headers, data: { label: name } });
  expect(renamed.status()).toBe(200);

  await openCanvas(page);
  const label = page.locator(".architecture-edge-label").filter({ hasText: "Nightly" });
  await expect(label).toBeVisible();
  // offsetWidth is the laid-out width; the bounding box would also carry the canvas zoom.
  const longWidth = await label.evaluate((element) => element.offsetWidth);
  expect(longWidth).toBeLessThanOrEqual(EDGE_LABEL_MAX_WIDTH);
  // The clipped name stays readable, and the whole of it is still available.
  await expect(label).toHaveAttribute("title", name);
  await expect(label).toHaveText(name);

  // A shorter name is a narrower chip, so the width follows the text instead of a fixed box.
  await request.patch(`/api/connections/${seeded.connectionId}`, { headers, data: { label: "Sync" } });
  await page.reload();
  await awaitEditorReady(page);
  const short = page.locator(".architecture-edge-label").filter({ hasText: "Sync" });
  await expect(short).toBeVisible();
  expect(await short.evaluate((element) => element.offsetWidth)).toBeLessThan(longWidth);
});

test("cursor feedback matches the active tool and the element under the pointer", async ({ page }) => {
  await signIn(await page.context(), owner.cookieValue);
  await openCanvasAsEditor(page);
  const alpha = node(page, seeded.alphaId);
  const system = node(page, seeded.systemId);
  const pane = page.locator(".react-flow__pane");
  await expect(alpha).toBeVisible();

  await expectCursor(alpha, "pointer");

  await page.keyboard.press(`${MOD}+b`);
  await expectCursor(system, "crosshair");
  await expectCursor(alpha, "pointer");

  await page.keyboard.press(`${MOD}+c`);
  await expectCursor(alpha, "crosshair");

  await page.keyboard.press(`${MOD}+e`);
  await expectCursor(alpha, "default");
  await expectCursor(page.locator(".architecture-edge-hitbox").first(), "crosshair");

  await page.keyboard.press(`${MOD}+h`);
  await expectCursor(pane, "grab");

  await page.keyboard.press(`${MOD}+s`);
  await expectCursor(pane, "default");
});
