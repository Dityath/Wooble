import { expect, test } from "bun:test";
import {
  EDGE_LABEL_HEIGHT,
  EDGE_LABEL_MAX_WIDTH,
  EDGE_LABEL_MIN_WIDTH,
  type EdgeLabelRoute,
  edgeLabelBox,
  edgeLabelSize,
  placeEdgeLabels,
  pointAlongRoute,
} from "../src/features/canvas/edge-label";

const at = (x: number, y: number) => ({ x, y });
const overlaps = (a: ReturnType<typeof edgeLabelBox>, b: ReturnType<typeof edgeLabelBox>) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test("a label reserves a box that follows its text instead of a fixed size", () => {
  const short = edgeLabelSize("REST");
  const medium = edgeLabelSize("Orders read");
  const long = edgeLabelSize("Nightly reconciliation export to the regional warehouse");
  expect(short.width).toBe(EDGE_LABEL_MIN_WIDTH);
  expect(medium.width).toBeGreaterThan(short.width);
  // The chip ellipsises at the cap, so a long name can never be wider than what the layout reserved for it.
  expect(long.width).toBe(EDGE_LABEL_MAX_WIDTH);
  for (const size of [short, medium, long]) expect(size.height).toBe(EDGE_LABEL_HEIGHT);
  // An unnamed connection falls back to the protocol name, which is never empty.
  expect(edgeLabelSize("").width).toBeGreaterThan(0);
});

test("the stylesheet keeps the rendered label within the width Auto Neat reserves", async () => {
  const stylesheet = await Bun.file(new URL("../src/product-design.css", import.meta.url)).text();
  const rule = stylesheet.match(/\.architecture-edge-label \{[^}]*\}/)?.[0] ?? "";
  expect(rule).toContain(`max-width: ${EDGE_LABEL_MAX_WIDTH}px`);
  expect(rule).toContain(`min-height: ${EDGE_LABEL_HEIGHT}px`);
  // The name is clipped inside its own span, because a flex container cannot show an ellipsis on its own text.
  const base = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const text = base.match(/\.architecture-edge-label \.edge-label-text \{[^}]*\}/)?.[0] ?? "";
  expect(text).toContain("overflow: hidden");
  expect(text).toContain("text-overflow: ellipsis");
  expect(text).toContain("white-space: nowrap");
});

test("points along a route walk its polyline by fraction of length", () => {
  const segments = [
    { from: at(0, 0), to: at(100, 0) },
    { from: at(100, 0), to: at(100, 100) },
  ];
  expect(pointAlongRoute(segments, 0)).toEqual(at(0, 0));
  expect(pointAlongRoute(segments, 0.25)).toEqual(at(50, 0));
  expect(pointAlongRoute(segments, 0.5)).toEqual(at(100, 0));
  expect(pointAlongRoute(segments, 0.75)).toEqual(at(100, 50));
  expect(pointAlongRoute(segments, 1)).toEqual(at(100, 100));
  // A degenerate route still yields its own point instead of NaN.
  expect(pointAlongRoute([{ from: at(7, 9), to: at(7, 9) }], 0.5)).toEqual(at(7, 9));
  expect(pointAlongRoute([], 0.5)).toEqual(at(0, 0));
});

test("a label steps along its route to clear the one connector it must cross", () => {
  const size = edgeLabelSize("REST");
  // The crossing route runs down the exact middle of the long horizontal leg.
  const crossed: EdgeLabelRoute = {
    id: "b",
    size,
    segments: [
      { from: at(50, 0), to: at(50, -60) },
      { from: at(50, 60), to: at(50, 120) },
    ],
  };
  const spanning: EdgeLabelRoute = {
    id: "a",
    size,
    segments: [
      { from: at(0, 0), to: at(20, 0) },
      { from: at(20, 0), to: at(20, -40) },
      { from: at(20, -40), to: at(180, -40) },
      { from: at(180, -40), to: at(180, 0) },
      { from: at(180, 0), to: at(200, 0) },
    ],
  };
  const anchors = placeEdgeLabels([crossed, spanning]);
  const crossedSegments = crossed.segments.map((segment) => ({
    left: Math.min(segment.from.x, segment.to.x),
    top: Math.min(segment.from.y, segment.to.y),
    right: Math.max(segment.from.x, segment.to.x),
    bottom: Math.max(segment.from.y, segment.to.y),
  }));
  const anchor = anchors.get("a");
  if (!anchor) throw new Error("Missing label anchor");
  const box = edgeLabelBox(anchor, size);
  expect(crossedSegments.some((segment) => overlaps(segment, box))).toBe(false);
  // The anchor stays on its own route, just no longer at the point the crossing sits on.
  expect(anchor.y).toBe(-40);
});

test("label anchors do not depend on the order the routes are given in", () => {
  const routes: EdgeLabelRoute[] = ["a", "b", "c"].map((id, index) => ({
    id,
    size: edgeLabelSize("REST"),
    segments: [
      { from: at(index * 10, 0), to: at(index * 10 + 100, 0) },
      { from: at(index * 10 + 100, 0), to: at(index * 10 + 100, 60) },
    ],
  }));
  const forward = placeEdgeLabels(routes);
  const backward = placeEdgeLabels([...routes].reverse());
  for (const route of routes) expect(backward.get(route.id)).toEqual(forward.get(route.id));
});
