import { expect, test } from "bun:test";
import { updateCanvasConnectionBendSchema } from "@wooble/contracts";
import {
  buildConnectorRoute,
  closestRouteInsertion,
  connectionSides,
  isHorizontalRoute,
  routeWaypoints,
} from "../src/features/canvas/connector-route";

test("legacy bends and ordered waypoint arrays both form editable routes", () => {
  expect(routeWaypoints({ x: 30, y: 40 })).toEqual([{ x: 30, y: 40 }]);
  expect(
    routeWaypoints([
      { x: 30, y: 40 },
      { x: 70, y: 80 },
    ]),
  ).toHaveLength(2);
  expect(updateCanvasConnectionBendSchema.safeParse({ bend: { x: 30, y: 40 } }).success).toBe(true);
  expect(
    updateCanvasConnectionBendSchema.safeParse({
      bend: [
        { x: 30, y: 40 },
        { x: 70, y: 80 },
      ],
    }).success,
  ).toBe(true);
  expect(
    updateCanvasConnectionBendSchema.safeParse({ bend: Array.from({ length: 13 }, () => ({ x: 1, y: 1 })) }).success,
  ).toBe(false);
});

test("a new point enters the clicked leg and the route stays orthogonal", () => {
  const route = buildConnectorRoute(
    { x: 0, y: 0 },
    { x: 300, y: 120 },
    [
      { x: 50, y: 80 },
      { x: 180, y: 160 },
    ],
    true,
  );
  expect(closestRouteInsertion(route.segments, { x: 120, y: 80 })).toBe(1);
  expect(closestRouteInsertion(route.segments, { x: 280, y: 160 })).toBe(2);
  expect(route.segments.every(({ from, to }) => from.x === to.x || from.y === to.y)).toBe(true);
  expect(route.path).toContain("L 180 160");
});

test("connector labels sit on the route while the label layer covers the line", () => {
  const horizontal = buildConnectorRoute({ x: 0, y: 80 }, { x: 300, y: 80 }, [{ x: 150, y: 80 }], true);
  const vertical = buildConnectorRoute({ x: 80, y: 0 }, { x: 80, y: 300 }, [{ x: 80, y: 150 }], false);
  expect(horizontal.label).toEqual({ x: 150, y: 80 });
  expect(vertical.label).toEqual({ x: 80, y: 150 });
  const uneven = buildConnectorRoute({ x: 0, y: 80 }, { x: 300, y: 80 }, [{ x: 80, y: 80 }], true);
  expect(uneven.label).toEqual({ x: 150, y: 80 });
  const detour = buildConnectorRoute({ x: 0, y: 0 }, { x: 300, y: 0 }, [{ x: 50, y: 100 }], true);
  expect(detour.label).toEqual({ x: 150, y: 100 });
});

test("connector routing follows the selected port side even when endpoint distances differ", () => {
  expect(isHorizontalRoute("source-bottom", { x: 400, y: 320 }, { x: 150, y: 430 })).toBe(false);
  expect(isHorizontalRoute("source-right", { x: 320, y: 400 }, { x: 430, y: 150 })).toBe(true);
});

test("connectionSides sends horizontal links between rows into the target's top or bottom", () => {
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
  const source = box(0, 200);
  expect(connectionSides(source, box(400, 400))).toEqual({ sourceSide: "right", targetSide: "top" });
  expect(connectionSides(source, box(-400, 400))).toEqual({ sourceSide: "left", targetSide: "top" });
  // The lower box (here the source) always uses its top; the upper box faces it.
  expect(connectionSides(source, box(400, 0))).toEqual({ sourceSide: "top", targetSide: "left" });
  expect(connectionSides(source, box(400, 200))).toEqual({ sourceSide: "right", targetSide: "left" });
  expect(connectionSides(source, box(-400, 200))).toEqual({ sourceSide: "left", targetSide: "right" });
  expect(connectionSides(source, box(0, 400))).toEqual({ sourceSide: "bottom", targetSide: "top" });
  expect(connectionSides(source, box(0, 0))).toEqual({ sourceSide: "top", targetSide: "bottom" });
  // Offset but still overlapping vertically: today's side-to-side rule.
  expect(connectionSides(source, box(400, 240))).toEqual({ sourceSide: "right", targetSide: "left" });
  expect(connectionSides(source, box(-400, 160))).toEqual({ sourceSide: "left", targetSide: "right" });
});

test("connectionSides is direction-agnostic: swapping the ends mirrors the sides", () => {
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
  const a = box(0, 200);
  for (const b of [box(400, 400), box(-400, 400), box(400, 0), box(400, 200), box(0, 400), box(0, 0), box(400, 240)]) {
    const forward = connectionSides(a, b);
    const reverse = connectionSides(b, a);
    expect(reverse).toEqual({ sourceSide: forward.targetSide, targetSide: forward.sourceSide });
  }
  // The user's case: IAM is below and to the right of Gateway, stored as IAM -> Gateway.
  const gateway = { x: 2352, y: 342, width: 220, height: 120 };
  const iam = { x: 2692, y: 572, width: 220, height: 120 };
  expect(connectionSides(iam, gateway)).toEqual({ sourceSide: "top", targetSide: "right" });
  expect(connectionSides(gateway, iam)).toEqual({ sourceSide: "right", targetSide: "top" });
});

test("connectionSides stays vertical when one box's centre sits within the other's x-range", () => {
  const wide = { x: 0, y: 200, width: 1000, height: 50 };
  const small = { x: 700, y: 270, width: 100, height: 50 };
  expect(connectionSides(wide, small)).toEqual({ sourceSide: "bottom", targetSide: "top" });
  expect(connectionSides(small, wide)).toEqual({ sourceSide: "top", targetSide: "bottom" });
  const wideBelow = { ...wide, y: 400 };
  expect(connectionSides(wideBelow, { ...small, y: 330 })).toEqual({ sourceSide: "top", targetSide: "bottom" });
  // Clear of the source's x-range it is still an L.
  expect(connectionSides(wide, { ...small, x: 1200 })).toEqual({ sourceSide: "right", targetSide: "top" });
});

// Target card x 300..400, y 200..250; its top handle is (350, 200), its bottom handle (350, 250).
const orthogonal = (segments: ReturnType<typeof buildConnectorRoute>["segments"]) =>
  segments.every(({ from, to }) => from.x === to.x || from.y === to.y);
const entersInterior = (segments: ReturnType<typeof buildConnectorRoute>["segments"]) =>
  segments.some(
    ({ from, to }) =>
      Math.max(from.x, to.x) > 300 &&
      Math.min(from.x, to.x) < 400 &&
      Math.max(from.y, to.y) > 200 &&
      Math.min(from.y, to.y) < 250,
  );

test("a legacy bend at the target's centre height detours to enter the top handle from above", () => {
  const source = { x: 100, y: 100 };
  const legacy = [{ x: 200, y: 225 }];
  const top = buildConnectorRoute(source, { x: 350, y: 200 }, legacy, true, "top");
  expect(orthogonal(top.segments)).toBe(true);
  expect(entersInterior(top.segments)).toBe(false);
  const last = top.segments[top.segments.length - 1];
  expect(last.from.x).toBe(last.to.x);
  expect(last.to).toEqual({ x: 350, y: 200 });
  expect(last.from.y).toBeLessThan(200);
  // Detour legs belong after the last waypoint, so dragging and inserting still address the right slot.
  expect(top.segments.slice(-3).every((segment) => segment.insertIndex === legacy.length)).toBe(true);
  expect(closestRouteInsertion(top.segments, { x: 350, y: 178 })).toBe(legacy.length);

  const bottom = buildConnectorRoute({ x: 100, y: 400 }, { x: 350, y: 250 }, [{ x: 200, y: 225 }], true, "bottom");
  expect(orthogonal(bottom.segments)).toBe(true);
  expect(entersInterior(bottom.segments)).toBe(false);
  const lastBottom = bottom.segments[bottom.segments.length - 1];
  expect(lastBottom.from.x).toBe(lastBottom.to.x);
  expect(lastBottom.to).toEqual({ x: 350, y: 250 });
  expect(lastBottom.from.y).toBeGreaterThan(250);
});

test("a waypoint already above the top handle finishes with the plain drop", () => {
  const top = (side?: "top") =>
    buildConnectorRoute({ x: 100, y: 100 }, { x: 350, y: 200 }, [{ x: 350, y: 100 }], true, side);
  expect(top("top").path).toBe(top().path);
  const bottom = (side?: "bottom") =>
    buildConnectorRoute({ x: 100, y: 400 }, { x: 350, y: 250 }, [{ x: 350, y: 400 }], true, side);
  expect(bottom("bottom").path).toBe(bottom().path);
});

test("without a target side, or with a left or right one, the route is unchanged", () => {
  const legacy = [{ x: 200, y: 225 }];
  const plain = buildConnectorRoute({ x: 100, y: 100 }, { x: 350, y: 200 }, legacy, true);
  expect(plain.path).toBe("M 100 100 L 200 100 L 200 225 L 350 225 L 350 200");
  for (const side of ["left", "right"] as const)
    expect(buildConnectorRoute({ x: 100, y: 100 }, { x: 350, y: 200 }, legacy, true, side).path).toBe(plain.path);
});

test("stale bends that run through an endpoint card are detected", async () => {
  const { routeEntersEndpoints, absoluteBox } = await import("../src/features/canvas/connector-route");
  const source = { x: 0, y: 300, width: 200, height: 100 };
  const target = { x: 0, y: 0, width: 200, height: 100 };
  // Source leaves its top edge, ends on the target's bottom: a clean vertical.
  const clean = buildConnectorRoute({ x: 100, y: 300 }, { x: 100, y: 100 }, [], false, "bottom");
  expect(routeEntersEndpoints(clean.segments, source, target)).toBe(false);
  // An old single bend at mid-height of the source card sends the first leg down into the source.
  const stale = buildConnectorRoute({ x: 100, y: 300 }, { x: 100, y: 100 }, [{ x: 60, y: 350 }], false, "bottom");
  expect(routeEntersEndpoints(stale.segments, source, target)).toBe(true);
  // Running along an edge is not entering the card.
  expect(routeEntersEndpoints([{ from: { x: 0, y: 300 }, to: { x: 0, y: 400 } }], source, target)).toBe(false);
  // Absolute boxes walk every parent level and survive cycles.
  const byId = new Map(
    [
      { entityId: "a", parentEntityId: "b", x: 1, y: 2, width: 5, height: 5 },
      { entityId: "b", parentEntityId: "c", x: 10, y: 20, width: 5, height: 5 },
      { entityId: "c", parentEntityId: "a", x: 100, y: 200, width: 5, height: 5 },
    ].map((item) => [item.entityId, item]),
  );
  expect(absoluteBox(byId.get("a") as never, byId as never)).toEqual({ x: 111, y: 222, width: 5, height: 5 });
});
