import { expect, test } from "@playwright/test";
import { addCanvasMember, MOD, registerUser, seedCanvas, signIn, type SeededCanvas, type TestUser } from "./helpers";

let owner: TestUser;
let viewer: TestUser;
let seeded: SeededCanvas;

test.beforeAll(async ({ request }) => {
  owner = await registerUser(request, "viewer-owner");
  viewer = await registerUser(request, "viewer-guest");
  seeded = await seedCanvas(request, owner.cookieValue);
  await addCanvasMember(request, owner.cookieValue, seeded.canvasId, viewer.email, "viewer");
});

function openCanvas(page: import("@playwright/test").Page) {
  return page.goto(`/canvases/${seeded.canvasId}`);
}

test("viewer can inspect but cannot edit, delete, or undo", async ({ page }) => {
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
});
