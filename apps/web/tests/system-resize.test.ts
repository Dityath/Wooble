import { expect, test } from "bun:test";
import type { CanvasNode } from "@wooble/domain";
import { canResizeSystem, resizedSystemPlacements } from "../src/features/canvas/system-resize";

const system: CanvasNode = {
  canvasId: "canvas",
  entityId: "system",
  parentEntityId: null,
  x: 100,
  y: 100,
  width: 500,
  height: 400,
};
const child: CanvasNode = {
  canvasId: "canvas",
  entityId: "service",
  parentEntityId: "system",
  x: 120,
  y: 120,
  width: 220,
  height: 120,
};

test("resizing from the top or left preserves child positions on the canvas", () => {
  const [resizedSystem, resizedChild] = resizedSystemPlacements(
    { system, children: [child] },
    { x: 60, y: 80, width: 540, height: 420 },
  );
  expect(resizedSystem).toMatchObject({ x: 60, y: 80, width: 540, height: 420 });
  expect(resizedChild).toMatchObject({ x: 160, y: 140, parentEntityId: "system" });
  expect((resizedSystem?.x ?? 0) + (resizedChild?.x ?? 0)).toBe(system.x + child.x);
  expect((resizedSystem?.y ?? 0) + (resizedChild?.y ?? 0)).toBe(system.y + child.y);
});

test("the system edge cannot be pulled over an existing child", () => {
  const snapshot = { system, children: [child] };
  expect(canResizeSystem(snapshot, { x: 100, y: 100, width: 500, height: 400 })).toBe(true);
  expect(canResizeSystem(snapshot, { x: 210, y: 100, width: 390, height: 400 })).toBe(false);
  expect(canResizeSystem(snapshot, { x: 100, y: 100, width: 340, height: 400 })).toBe(false);
  expect(canResizeSystem(snapshot, { x: 100, y: 100, width: 500, height: 220 })).toBe(false);
  expect(canResizeSystem(snapshot, { x: 60, y: 80, width: 540, height: 420 })).toBe(true);
});

test("resizing the right edge saves only the system placement", () => {
  const placements = resizedSystemPlacements(
    { system, children: [child] },
    { x: 100, y: 100, width: 620, height: 400 },
  );
  expect(placements).toHaveLength(1);
  expect(placements[0]?.width).toBe(620);
});
