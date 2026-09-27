import { expect, test } from "bun:test";
import { updateCanvasConnectionBendSchema } from "@wooble/contracts";
import {
  buildConnectorRoute,
  closestRouteInsertion,
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
