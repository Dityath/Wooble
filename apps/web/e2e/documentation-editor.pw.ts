import { expect, test, type Page } from "@playwright/test";
import { MOD, registerUser, seedCanvas, signIn, type SeededCanvas, type TestUser } from "./helpers";

let owner: TestUser;
let seeded: SeededCanvas;

test.beforeAll(async ({ request }) => {
  owner = await registerUser(request, "writer");
});

test.beforeEach(async ({ request, context }) => {
  seeded = await seedCanvas(request, owner.cookieValue);
  await signIn(context, owner.cookieValue);
});

const node = (page: Page, entityId: string) => page.locator(`.react-flow__node[data-id="${entityId}"]`);
const edgeLabel = (page: Page) => page.locator(".architecture-edge-label").filter({ hasText: "REST" });
const detailsDialog = (page: Page) => page.getByRole("dialog", { name: "Canvas details" });
const documentationEditor = (page: Page) => detailsDialog(page).getByRole("textbox", { name: "Documentation" });
const saveState = (page: Page) => detailsDialog(page).locator(".documentation-card").getByRole("status");
const slashMenu = (page: Page) => page.getByRole("listbox", { name: "Insert block" });
// The modal details dialog hides the rest of the page from assistive technology, toolbox included.
const toolButton = (page: Page, name: string) =>
  page.locator(".canvas-toolbox").getByRole("button", { name, exact: true, includeHidden: true });

// The editor attaches its global key handlers in a post-commit effect; wait for the mounted surface.
async function openCanvas(page: Page) {
  await page.goto(`/canvases/${seeded.canvasId}`);
  await expect(node(page, seeded.betaId)).toBeVisible();
  await expect(page.locator(".canvas-toolbox")).toBeVisible();
}

async function openDocumentationFromInspector(page: Page) {
  await page.locator(".inspector-panel").getByRole("button", { name: "Documentation", exact: true }).click();
  await expect(documentationEditor(page)).toBeVisible();
}

async function openNodeDocumentation(page: Page, entityId: string) {
  await node(page, entityId).click();
  await openDocumentationFromInspector(page);
}

async function openConnectionDocumentation(page: Page) {
  await page.keyboard.press(`${MOD}+e`);
  await expect(page.locator(".canvas-tool-options")).toContainText("connector");
  await edgeLabel(page).click();
  await openDocumentationFromInspector(page);
}

async function storedDocumentation(page: Page, path: string) {
  const response = await page.request.get(path);
  expect(response.ok()).toBe(true);
  const { metadata } = (await response.json()) as { metadata: { documentation?: string | null } };
  return metadata.documentation ?? null;
}

/** Pastes `text` as a plain-text clipboard, the way a paste from a text editor arrives. */
async function pastePlainText(page: Page, text: string) {
  await documentationEditor(page).evaluate((element, pasted) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test("slash menu and Markdown shortcuts build documentation that autosaves and survives a reload", async ({ page }) => {
  await openCanvas(page);
  await openNodeDocumentation(page, seeded.alphaId);
  const editor = documentationEditor(page);
  const menu = slashMenu(page);
  await expect(saveState(page)).toHaveText("");

  await editor.click();
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await page.keyboard.type("head");
  const headingOne = menu.getByRole("option", { name: /^Heading 1/ });
  await expect(headingOne).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { name: /^Heading 2/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(headingOne).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveAttribute("aria-activedescendant", (await headingOne.getAttribute("id")) ?? "");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();

  await page.keyboard.type("Payments API");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Validates checkout requests");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Publishes payment events");
  await expect(saveState(page)).toHaveText("Saved");
  await expect
    .poll(() => storedDocumentation(page, `/api/entities/${seeded.alphaId}`))
    .toBe("# Payments API\n\n- Validates checkout requests\n- Publishes payment events");

  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  await openNodeDocumentation(page, seeded.alphaId);
  await expect(editor.getByRole("heading", { level: 1, name: "Payments API" })).toBeVisible();
  await expect(editor.getByRole("listitem")).toHaveText(["Validates checkout requests", "Publishes payment events"]);
  await expect(saveState(page)).toHaveText("");
});

test("Escape closes the slash menu, then leaves the editor, then closes the dialog", async ({ page }) => {
  await openCanvas(page);
  await openNodeDocumentation(page, seeded.alphaId);
  const dialog = detailsDialog(page);
  const editor = documentationEditor(page);
  const menu = slashMenu(page);

  await editor.click();
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).not.toHaveAttribute("aria-activedescendant");

  // A mouse click on an option works inside the modal dialog and keeps the caret in the editor.
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await menu.getByRole("option", { name: /^Quote/ }).click();
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.type("Card numbers never leave the vault.");
  await expect(editor.locator("blockquote")).toHaveText("Card numbers never leave the vault.");

  // Without a menu, Escape leaves the editor and the blur saves; the dialog stays open.
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(saveState(page)).toHaveText("Saved");
  await expect
    .poll(() => storedDocumentation(page, `/api/entities/${seeded.alphaId}`))
    .toBe("> Card numbers never leave the vault.");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("pasted Markdown becomes blocks that persist", async ({ page }) => {
  await openCanvas(page);
  await openNodeDocumentation(page, seeded.betaId);
  const editor = documentationEditor(page);

  await editor.click();
  await pastePlainText(
    page,
    "## Rollout\n\n- [ ] Enable the billing flag\n- [x] Notify support\n\n| Region | Owner |\n| --- | --- |\n| EU | Platform |",
  );
  await expect(editor.getByRole("heading", { level: 2, name: "Rollout" })).toBeVisible();
  await expect(editor.getByRole("checkbox")).toHaveCount(2);
  await expect(editor.getByRole("checkbox").nth(1)).toBeChecked();
  await expect(editor.getByRole("table")).toContainText("Platform");
  await expect(saveState(page)).toHaveText("Saved");
  await expect
    .poll(() => storedDocumentation(page, `/api/entities/${seeded.betaId}`))
    // The editor writes tables with a blank line around them and pads their columns.
    .toBe(
      "## Rollout\n\n- [ ] Enable the billing flag\n- [x] Notify support\n\n\n| Region | Owner    |\n| ------ | -------- |\n| EU     | Platform |",
    );

  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  await openNodeDocumentation(page, seeded.betaId);
  await expect(editor.getByRole("heading", { level: 2, name: "Rollout" })).toBeVisible();
  await expect(editor.getByRole("checkbox")).toHaveCount(2);
  await expect(editor.getByRole("table")).toContainText("Platform");
});

test("typing in the documentation editor never switches tools or deletes the node", async ({ page }) => {
  await openCanvas(page);
  await openNodeDocumentation(page, seeded.alphaId);
  const editor = documentationEditor(page);
  const deletions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletions.push(request.url());
  });

  await editor.click();
  // "n" would switch to Add node and Backspace would open the delete dialog if the editor leaked keys to the canvas.
  await page.keyboard.press("n");
  await expect(editor).toHaveText("n");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(editor).toHaveText("");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(detailsDialog(page)).not.toContainText("Delete Alpha Service?");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await expect(toolButton(page, "Add node")).toHaveAttribute("aria-pressed", "false");

  // The document ends as it started, and nothing was deleted.
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detailsDialog(page)).toBeHidden();
  await expect(node(page, seeded.alphaId)).toBeVisible();
  await expect.poll(() => storedDocumentation(page, `/api/entities/${seeded.alphaId}`)).toBeNull();
  expect(deletions).toEqual([]);
});

test("connector documentation saves and persists", async ({ page }) => {
  await openCanvas(page);
  await openConnectionDocumentation(page);
  const editor = documentationEditor(page);

  await editor.click();
  await page.keyboard.type("Retries use **exponential** backoff.");
  await expect(editor.locator("strong")).toHaveText("exponential");
  await expect(saveState(page)).toHaveText("Saved");
  await expect
    .poll(() => storedDocumentation(page, `/api/connections/${seeded.connectionId}`))
    .toBe("Retries use **exponential** backoff.");

  await page.reload();
  await expect(node(page, seeded.betaId)).toBeVisible();
  await openConnectionDocumentation(page);
  await expect(editor).toHaveText("Retries use exponential backoff.");
  await expect(editor.locator("strong")).toHaveText("exponential");
});
