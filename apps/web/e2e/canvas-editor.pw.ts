import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { MOD, MOD_SYMBOL, registerUser, seedCanvas, signIn, type SeededCanvas, type TestUser } from "./helpers";

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

  let held: Route | undefined;
  await page.route("**/api/canvases/*/auto-neat", async (route) => {
    held = route;
    await new Promise(() => {});
  });
  await toolButton(page, "Auto Neat").click();
  await expect(page.locator(".canvas-auto-neat-status")).toContainText("Tidying canvas…");
  for (const name of TOOL_NAMES) await expect(toolButton(page, name)).toBeDisabled();

  // Keyboard switching is swallowed while busy…
  await page.keyboard.press(`${MOD}+s`);
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "false");
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "true");
  // …and the disabled buttons ignore mouse clicks on the same state.
  await expect(toolButton(page, "Select")).toBeDisabled();

  if (!held) throw new Error("auto-neat request was never intercepted");
  await held.abort();
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
  await page.keyboard.press("Delete");
  await expect(firstPoint).toBeHidden();
  await expect(edgeLabel(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await hitbox.focus();
  await page.keyboard.press("Enter");
  const secondPoint = page.getByRole("button", { name: /Connector point 1/ });
  await expect(secondPoint).toBeVisible();
  await secondPoint.focus();
  await page.keyboard.press("Backspace");
  await expect(secondPoint).toBeHidden();
  await expect(edgeLabel(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The connector itself survives: reload still shows it.
  await page.reload();
  await awaitEditorReady(page);
  await expect(edgeLabel(page)).toBeVisible();
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
