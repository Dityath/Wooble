import type { ConnectionBend } from "@wooble/domain";

/**
 * Rendered geometry of the connector label chip, mirrored from `.architecture-edge-label`.
 *
 * The label is a single-line chip whose text follows the connection name, so the box has to be measured from the
 * text rather than assumed. The stylesheet caps the text with `max-width`, which makes the cap below exact: a long
 * name is ellipsised and can never grow past the width Auto Neat reserved for it.
 */
export const EDGE_LABEL_HEIGHT = 28;
export const EDGE_LABEL_MIN_WIDTH = 84;
export const EDGE_LABEL_MAX_WIDTH = 190;
/** Font size the stylesheet renders the label at. */
const EDGE_LABEL_FONT_SIZE = 11;
/** Dot, gap, inline padding and borders around the text. */
const EDGE_LABEL_CHROME = 5 + 5 + 9 * 2 + 1 * 2;
/** Upper bound for one rendered character. Erring wide keeps Auto Neat conservative about collisions. */
const EDGE_LABEL_CHARACTER = Math.ceil(EDGE_LABEL_FONT_SIZE * 0.62);

export interface EdgeLabelSize {
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function edgeLabelSize(title: string): EdgeLabelSize {
  const characters = [...title.trim()].length || 1;
  return {
    width: Math.min(
      EDGE_LABEL_MAX_WIDTH,
      Math.max(EDGE_LABEL_MIN_WIDTH, EDGE_LABEL_CHROME + characters * EDGE_LABEL_CHARACTER),
    ),
    height: EDGE_LABEL_HEIGHT,
  };
}

export function edgeLabelBox(center: ConnectionBend, size: EdgeLabelSize): Box {
  return {
    left: center.x - size.width / 2,
    top: center.y - size.height / 2,
    right: center.x + size.width / 2,
    bottom: center.y + size.height / 2,
  };
}

const segmentBox = (segment: { from: ConnectionBend; to: ConnectionBend }): Box => ({
  left: Math.min(segment.from.x, segment.to.x),
  top: Math.min(segment.from.y, segment.to.y),
  right: Math.max(segment.from.x, segment.to.x),
  bottom: Math.max(segment.from.y, segment.to.y),
});

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const manhattan = (a: ConnectionBend, b: ConnectionBend) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Points along the polyline at a fraction of its total length. */
export function pointAlongRoute(segments: ReadonlyArray<RouteLike>, fraction: number): ConnectionBend {
  const first = segments[0];
  if (!first) return { x: 0, y: 0 };
  const total = segments.reduce((sum, segment) => sum + manhattan(segment.from, segment.to), 0);
  if (total <= 0) return { x: first.from.x, y: first.from.y };
  let remaining = total * fraction;
  for (const { from, to } of segments) {
    const length = manhattan(from, to);
    if (length > 0 && remaining <= length) {
      const share = remaining / length;
      return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
    }
    remaining -= length;
  }
  const last = segments[segments.length - 1].to;
  return { x: last.x, y: last.y };
}

export interface RouteLike {
  from: ConnectionBend;
  to: ConnectionBend;
}

/** A route that has already claimed a label, with the boxes a new label has to be checked against. */
export interface TakenLabel {
  box: Box;
  bounds: Box;
  segments: readonly RouteLike[];
}

export interface EdgeLabelRoute {
  id: string;
  segments: ReadonlyArray<RouteLike>;
  size: EdgeLabelSize;
}

/**
 * Where a label may sit along its own route, most preferred first. The arc-length midpoint comes first because it
 * keeps a straight connector centred; the rest step away from it so a label can step around the one connector a
 * route is forced to cross.
 */
const LABEL_ANCHORS = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8, 0.12, 0.88];

const boundsOf = (segments: readonly RouteLike[]): Box => {
  const first = segmentBox(segments[0] ?? { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } });
  return segments.reduce<Box>((bounds, segment) => {
    const box = segmentBox(segment);
    return {
      left: Math.min(bounds.left, box.left),
      top: Math.min(bounds.top, box.top),
      right: Math.max(bounds.right, box.right),
      bottom: Math.max(bounds.bottom, box.bottom),
    };
  }, first);
};

// A label may sit on its own route (that is where the route reads best) but never on another connector or label.
const isClear = (box: Box, taken: readonly TakenLabel[]) =>
  !taken.some(
    (other) =>
      overlaps(box, other.box) ||
      (overlaps(box, other.bounds) && other.segments.some((segment) => overlaps(segmentBox(segment), box))),
  );

/** First anchor whose box no already-placed label and no already-placed route crosses. */
export function firstClearAnchor(route: EdgeLabelRoute, taken: readonly TakenLabel[]): ConnectionBend {
  const fallback = pointAlongRoute(route.segments, LABEL_ANCHORS[0]);
  // Almost every route is clear at its midpoint, so that single check is the common case; the ladder only runs
  // when the connector really does cross something.
  const midpoint = edgeLabelBox(fallback, route.size);
  if (isClear(midpoint, taken)) return fallback;
  for (const fraction of LABEL_ANCHORS) {
    const point = pointAlongRoute(route.segments, fraction);
    if (isClear(edgeLabelBox(point, route.size), taken)) return point;
  }
  return fallback;
}

/**
 * Resolves every label anchor from the whole route set at once, so Auto Neat and the renderer agree on where a
 * label sits from a stored bend alone. Ordered by connection id, so the result never depends on call order.
 */
export function placeEdgeLabels(routes: readonly EdgeLabelRoute[]): Map<string, ConnectionBend> {
  const taken: TakenLabel[] = [];
  const result = new Map<string, ConnectionBend>();
  for (const route of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
    const segments = route.segments.filter((segment) => manhattan(segment.from, segment.to) > 0);
    const point = segments.length
      ? firstClearAnchor({ ...route, segments }, taken)
      : pointAlongRoute(route.segments, LABEL_ANCHORS[0]);
    result.set(route.id, point);
    taken.push({ box: edgeLabelBox(point, route.size), bounds: boundsOf(segments), segments });
  }
  return result;
}
