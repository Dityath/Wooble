import type { CanvasNode, ConnectionBend } from "@wooble/domain";
import type { CanvasGraph } from "../../lib/api";
import { type ConnectorPorts, connectorPorts } from "./connector-ports";
import { type ConnectorBox, type ConnectorSide, absoluteBox, buildConnectorRoute } from "./connector-route";

export interface AutoNeatLayout {
  placements: Array<Omit<CanvasNode, "canvasId">>;
  connections: Array<{ connectionId: string; bend: ConnectionBend | ConnectionBend[] }>;
}

const NODE_GAP_X = 120;
const NODE_GAP_Y = 110;
const SYSTEM_GAP_X = 300;
const SYSTEM_PADDING_X = 64;
const SYSTEM_PADDING_TOP = 112;
const SYSTEM_PADDING_BOTTOM = 48;
const CARD_PADDING = 8;
const CLEARANCE = 8;
const CROSS_MARGIN = 4;
const LABEL_WIDTH = 84;
const LABEL_HEIGHT = 26;
const LANE_SPACING = 18;
const GAP_MARGIN = 12;
const EXIT_OFFSETS = [24, 48, 72];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
type Point = ConnectionBend;
interface Segment {
  from: Point;
  to: Point;
  box: Box;
  vertical: boolean;
}
interface PlacedRoute {
  segments: Segment[];
  label: Box;
  bounds: Box;
}
interface Card {
  id: string;
  box: Box;
  padded: Box;
}

const flat = (side: ConnectorSide) => side === "left" || side === "right";
const toBox = (box: ConnectorBox): Box => ({
  left: box.x,
  top: box.y,
  right: box.x + box.width,
  bottom: box.y + box.height,
});
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const toSegment = ({ from, to }: { from: Point; to: Point }): Segment => ({
  from,
  to,
  vertical: from.x === to.x,
  box: {
    left: Math.min(from.x, to.x),
    right: Math.max(from.x, to.x),
    top: Math.min(from.y, to.y),
    bottom: Math.max(from.y, to.y),
  },
});
const segmentLength = ({ from, to }: Segment) => Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
const union = (segments: Segment[]): Box => ({
  left: Math.min(...segments.map((s) => s.box.left)),
  top: Math.min(...segments.map((s) => s.box.top)),
  right: Math.max(...segments.map((s) => s.box.right)),
  bottom: Math.max(...segments.map((s) => s.box.bottom)),
});
const near = (a: Box, b: Box, margin: number) =>
  a.left <= b.right + margin && a.right >= b.left - margin && a.top <= b.bottom + margin && a.bottom >= b.top - margin;

// Two segments conflict when they cross or touch, or run side by side closer than CLEARANCE.
function segmentsConflict(a: Segment, b: Segment) {
  const boxA = a.box;
  const boxB = b.box;
  if (a.vertical === b.vertical) {
    const close = a.vertical ? Math.abs(a.from.x - b.from.x) : Math.abs(a.from.y - b.from.y);
    if (close >= CLEARANCE) return false;
    const shared = a.vertical
      ? Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top)
      : Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
    return shared > 0;
  }
  const vertical = a.vertical ? boxA : boxB;
  const horizontal = a.vertical ? boxB : boxA;
  return (
    vertical.left >= horizontal.left - CROSS_MARGIN &&
    vertical.left <= horizontal.right + CROSS_MARGIN &&
    horizontal.top >= vertical.top - CROSS_MARGIN &&
    horizontal.top <= vertical.bottom + CROSS_MARGIN
  );
}

// Penalty of a route against cards and the routes placed so far; stops as soon as it cannot beat `limit`.
function scoreRoute(
  segments: Segment[],
  bounds: Box,
  labelBox: Box,
  cards: Card[],
  placed: PlacedRoute[],
  ownIds: string[],
  base: number,
  limit: number,
) {
  let cost = base;
  for (const card of cards) {
    const own = ownIds.includes(card.id);
    if (!overlaps(bounds, own ? card.box : card.padded)) continue;
    if (segments.some((segment) => overlaps(segment.box, own ? card.box : card.padded))) cost += 1000;
    if (cost >= limit) return cost;
  }
  for (const other of placed) {
    if (near(bounds, other.bounds, CLEARANCE)) {
      for (const segment of segments) {
        if (!near(segment.box, other.bounds, CLEARANCE)) continue;
        for (const otherSegment of other.segments) if (segmentsConflict(segment, otherSegment)) cost += 100;
      }
      if (cost >= limit) return cost;
    }
  }
  for (const card of cards) if (overlaps(labelBox, card.box)) cost += 10;
  for (const other of placed) {
    if (overlaps(labelBox, other.label)) cost += 10;
    if (overlaps(labelBox, other.bounds) && other.segments.some((segment) => overlaps(segment.box, labelBox)))
      cost += 10;
    if (overlaps(bounds, other.label) && segments.some((segment) => overlaps(segment.box, other.label))) cost += 10;
    if (cost >= limit) return cost;
  }
  return cost;
}

const spread = (center: number, min: number, max: number, step: number) =>
  [0, -1, 1, -2, 2, -3, 3].map((k) => Math.round(center + k * step)).filter((value) => value >= min && value <= max);

// Corner points from the upper (or left) box A to the other box B; the renderer's waypoints are every second corner.
type Corners = Point[];

export function candidateCorners(
  kind: number,
  a: Point,
  b: Point,
  aSide: ConnectorSide,
  aBox: ConnectorBox,
  bBox: ConnectorBox,
): Corners[] {
  const d = aSide === "left" ? -1 : 1;
  const point = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y) });
  if (kind === 0) {
    if (Math.abs(a.x - b.x) < 1) return [[]];
    const jogs = spread((a.y + b.y) / 2, a.y + GAP_MARGIN, b.y - GAP_MARGIN, LANE_SPACING);
    return (jogs.length ? jogs : [Math.round((a.y + b.y) / 2)]).map((y) => [point(a.x, y), point(b.x, y)]);
  }
  if (kind === 1) {
    const result: Corners[] = [[point(b.x, a.y)]];
    for (const lift of [55, 35, 75, 95])
      for (const offset of EXIT_OFFSETS) {
        const y = b.y - lift;
        const x = a.x + d * offset;
        if (y > a.y + GAP_MARGIN && (b.x - x) * d > 0) result.push([point(x, a.y), point(x, y), point(b.x, y)]);
      }
    return result;
  }
  const result: Corners[] = [];
  const mid = (a.x + b.x) / 2;
  if (Math.abs(a.y - b.y) < 1) result.push([]);
  else
    for (const x of spread(mid, a.x + GAP_MARGIN, b.x - GAP_MARGIN, LANE_SPACING))
      result.push([point(x, a.y), point(x, b.y)]);
  const around = (levels: number[]) => {
    for (const y of levels)
      for (const exit of EXIT_OFFSETS)
        for (const entry of EXIT_OFFSETS)
          if (a.x + exit < b.x - entry)
            result.push([point(a.x + exit, a.y), point(a.x + exit, y), point(b.x - entry, y), point(b.x - entry, b.y)]);
  };
  const top = Math.min(aBox.y, bBox.y);
  const bottom = Math.max(aBox.y + aBox.height, bBox.y + bBox.height);
  around([36, 52, 68, 84].map((lift) => top - lift));
  around([36, 52, 68, 84].map((drop) => bottom + drop));
  // Side-by-side or overlapping boxes leave no room for the generated routes: always keep the plain midpoint Z.
  if (!result.length) result.push([]);
  return result;
}

// The renderer draws waypoints as horizontal-then-vertical (or the reverse) legs, so each pair of corners needs one waypoint.
function waypointsFor(corners: Corners, source: Point, target: Point, horizontal: boolean): ConnectionBend[] {
  const picks = corners.filter((_, index) => index % 2 === 1);
  if (picks.length) return picks;
  if (corners.length) return [corners[0]];
  return [
    horizontal
      ? { x: Math.round((source.x + target.x) / 2), y: Math.round(target.y) }
      : { x: Math.round(target.x), y: Math.round((source.y + target.y) / 2) },
  ];
}

export function buildAutoNeatLayout(graph: CanvasGraph): AutoNeatLayout {
  const placements = graph.placements.map((placement) => ({ ...placement }));
  const byId = new Map(placements.map((placement) => [placement.entityId, placement]));
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const systemIds = new Set(graph.entities.filter((entity) => entity.type === "system").map((entity) => entity.id));
  const children = new Map<string, typeof placements>();
  const roots: typeof placements = [];
  for (const placement of placements) {
    if (placement.parentEntityId && byId.has(placement.parentEntityId)) {
      const siblings = children.get(placement.parentEntityId) ?? [];
      siblings.push(placement);
      children.set(placement.parentEntityId, siblings);
    } else roots.push(placement);
  }
  const rank = (node: CanvasNode) => {
    switch (entities.get(node.entityId)?.type) {
      case "frontend":
      case "device":
        return 0;
      case "gateway":
        return 1;
      case "database":
      case "broker":
        return 3;
      default:
        return 2;
    }
  };
  const relatedUpstream = (node: CanvasNode) => {
    const connection = graph.connections.find((item) => {
      const otherId =
        item.targetEntityId === node.entityId
          ? item.sourceEntityId
          : item.sourceEntityId === node.entityId
            ? item.targetEntityId
            : null;
      const other = otherId ? byId.get(otherId) : null;
      return other?.parentEntityId === node.parentEntityId && rank(other) === 2;
    });
    const otherId =
      connection?.targetEntityId === node.entityId ? connection.sourceEntityId : connection?.targetEntityId;
    return otherId ? byId.get(otherId) : undefined;
  };
  const readingOrder = (a: CanvasNode, b: CanvasNode) => {
    const aName = entities.get(a.entityId)?.name ?? "";
    const bName = entities.get(b.entityId)?.name ?? "";
    const aGroup = rank(a) === 3 ? (entities.get(relatedUpstream(a)?.entityId ?? "")?.name ?? aName) : aName;
    const bGroup = rank(b) === 3 ? (entities.get(relatedUpstream(b)?.entityId ?? "")?.name ?? bName) : bName;
    return (
      rank(a) - rank(b) ||
      aGroup.localeCompare(bGroup) ||
      aName.localeCompare(bName) ||
      a.entityId.localeCompare(b.entityId)
    );
  };
  const visiting = new Set<string>();
  const arranged = new Set<string>();
  const arrangeSystem = (system: CanvasNode) => {
    if (arranged.has(system.entityId) || visiting.has(system.entityId)) return;
    visiting.add(system.entityId);
    const items = (children.get(system.entityId) ?? []).sort(readingOrder);
    for (const item of items) if (systemIds.has(item.entityId)) arrangeSystem(item);
    const rows = [0, 1, 2, 3].map((level) => items.filter((item) => rank(item) === level)).filter((row) => row.length);
    const rowWidth = (row: CanvasNode[]) =>
      row.reduce((width, item) => width + item.width, 0) + NODE_GAP_X * Math.max(0, row.length - 1);
    const contentWidth = Math.max(0, ...rows.map(rowWidth));
    let rowY = SYSTEM_PADDING_TOP;
    for (const row of rows) {
      if (rank(row[0]) === 3)
        row.sort(
          (a, b) =>
            (relatedUpstream(a)?.x ?? Number.MAX_SAFE_INTEGER) - (relatedUpstream(b)?.x ?? Number.MAX_SAFE_INTEGER) ||
            readingOrder(a, b),
        );
      let nextX = rank(row[0]) === 3 ? SYSTEM_PADDING_X : SYSTEM_PADDING_X + (contentWidth - rowWidth(row)) / 2;
      for (const item of row) {
        const source = rank(item) === 3 ? relatedUpstream(item) : undefined;
        const preferredX = source ? source.x + (source.width - item.width) / 2 : nextX;
        item.x = Math.round(Math.max(nextX, preferredX));
        item.y = rowY;
        nextX = item.x + item.width + NODE_GAP_X;
      }
      rowY += Math.max(...row.map((item) => item.height)) + NODE_GAP_Y;
    }
    if (rows.length) {
      const right = Math.max(...items.map((item) => item.x + item.width));
      system.width = Math.max(300, right + SYSTEM_PADDING_X);
      system.height = Math.max(220, rowY - NODE_GAP_Y + SYSTEM_PADDING_BOTTOM);
    }
    visiting.delete(system.entityId);
    arranged.add(system.entityId);
  };
  for (const system of placements.filter((placement) => systemIds.has(placement.entityId))) arrangeSystem(system);

  const rootSystems = roots.filter((placement) => systemIds.has(placement.entityId)).sort(readingOrder);
  const otherRoots = roots.filter((placement) => !systemIds.has(placement.entityId)).sort(readingOrder);
  let systemX = 0;
  for (const system of rootSystems) {
    system.x = systemX;
    system.y = 0;
    systemX += system.width + SYSTEM_GAP_X;
  }
  let rootY = rootSystems.length ? Math.max(...rootSystems.map((system) => system.height)) + NODE_GAP_Y : 0;
  const rootRowWidth = (row: CanvasNode[]) =>
    row.reduce((width, item) => width + item.width, 0) + NODE_GAP_X * Math.max(0, row.length - 1);
  const rootContentWidth = Math.max(
    0,
    ...[0, 1, 2, 3].map((level) => rootRowWidth(otherRoots.filter((node) => rank(node) === level))),
  );
  for (const level of [0, 1, 2, 3]) {
    const row = otherRoots.filter((node) => rank(node) === level);
    if (!row.length) continue;
    if (level === 3)
      row.sort(
        (a, b) =>
          (relatedUpstream(a)?.x ?? Number.MAX_SAFE_INTEGER) - (relatedUpstream(b)?.x ?? Number.MAX_SAFE_INTEGER) ||
          readingOrder(a, b),
      );
    let rootX = level === 3 ? 0 : (rootContentWidth - rootRowWidth(row)) / 2;
    for (const node of row) {
      const source = level === 3 ? relatedUpstream(node) : undefined;
      node.x = Math.round(Math.max(rootX, source ? source.x + (source.width - node.width) / 2 : rootX));
      node.y = rootY;
      rootX = node.x + node.width + NODE_GAP_X;
    }
    rootY += Math.max(...row.map((node) => node.height)) + NODE_GAP_Y;
  }

  const boxes = new Map(placements.map((node) => [node.entityId, absoluteBox(node, byId)]));
  const portsById = connectorPorts(boxes, graph.connections);
  const cards: Card[] = placements
    .filter((placement) => !systemIds.has(placement.entityId))
    .flatMap((placement) => {
      const box = boxes.get(placement.entityId);
      if (!box) return [];
      const plain = toBox(box);
      return [
        {
          id: placement.entityId,
          box: plain,
          padded: {
            left: plain.left - CARD_PADDING,
            top: plain.top - CARD_PADDING,
            right: plain.right + CARD_PADDING,
            bottom: plain.bottom + CARD_PADDING,
          },
        },
      ];
    });

  // Routes are placed greedily: straight and Z links first, then Ls by run length, then same-row links.
  interface Job {
    id: string;
    kind: number;
    run: number;
    ports: ConnectorPorts;
    swapped: boolean;
    sourceId: string;
    targetId: string;
  }
  const jobs: Job[] = [];
  const bends = new Map<string, ConnectionBend | ConnectionBend[]>();
  for (const connection of [...graph.connections].sort((a, b) => a.id.localeCompare(b.id))) {
    const ports = portsById.get(connection.id);
    if (!ports || connection.sourceEntityId === connection.targetEntityId) {
      // Unplaced endpoints and self-links are not routed: keep the stored bend as is (the contract needs a non-null one).
      const stored = connection.bend;
      bends.set(
        connection.id,
        Array.isArray(stored) ? (stored.length ? stored : { x: 0, y: 0 }) : (stored ?? { x: 0, y: 0 }),
      );
      continue;
    }
    const kind =
      flat(ports.sourceSide) && flat(ports.targetSide) ? 2 : flat(ports.sourceSide) || flat(ports.targetSide) ? 1 : 0;
    // A is the box the corners are described from: the upper one (the one with the flat side in an L), or the left one.
    const swapped =
      kind === 0 ? ports.sourceSide !== "bottom" : kind === 1 ? !flat(ports.sourceSide) : ports.sourceSide === "left";
    jobs.push({
      id: connection.id,
      kind,
      run: Math.abs(ports.source.x - ports.target.x),
      ports,
      swapped,
      sourceId: connection.sourceEntityId,
      targetId: connection.targetEntityId,
    });
  }
  jobs.sort((a, b) => a.kind - b.kind || a.run - b.run || a.id.localeCompare(b.id));

  const placed: PlacedRoute[] = [];
  for (const job of jobs) {
    const { ports, swapped } = job;
    const horizontal = flat(ports.sourceSide);
    const a = swapped ? ports.target : ports.source;
    const b = swapped ? ports.source : ports.target;
    const aBox = boxes.get(swapped ? job.targetId : job.sourceId);
    const bBox = boxes.get(swapped ? job.sourceId : job.targetId);
    if (!aBox || !bBox) continue;
    const aSide = swapped ? ports.targetSide : ports.sourceSide;
    let best: { cost: number; waypoints: ConnectionBend[]; route: PlacedRoute } | undefined;
    const candidates = candidateCorners(job.kind, a, b, aSide, aBox, bBox);
    for (const [index, corners] of candidates.entries()) {
      const waypoints = waypointsFor(
        swapped ? [...corners].reverse() : corners,
        ports.source,
        ports.target,
        horizontal,
      );
      const built = buildConnectorRoute(ports.source, ports.target, waypoints, horizontal, ports.targetSide);
      const segments = built.segments.map(toSegment);
      const labelBox = {
        left: built.label.x - LABEL_WIDTH / 2,
        top: built.label.y - LABEL_HEIGHT / 2,
        right: built.label.x + LABEL_WIDTH / 2,
        bottom: built.label.y + LABEL_HEIGHT / 2,
      };
      const bounds = segments.length ? union(segments) : labelBox;
      const length = segments.reduce((total, segment) => total + segmentLength(segment), 0);
      const base = Math.round(length / 10) * 0.1 + index * 0.001;
      const cost = scoreRoute(
        segments,
        bounds,
        labelBox,
        cards,
        placed,
        [job.sourceId, job.targetId],
        base,
        best ? best.cost : Number.POSITIVE_INFINITY,
      );
      if (!best || cost < best.cost) best = { cost, waypoints, route: { segments, label: labelBox, bounds } };
      // Candidates are ordered by preference: a clean one needs no comparison with the rest.
      if (cost - base < 1) break;
    }
    if (!best) {
      // Unreachable (candidateCorners never returns none), but a connection must never be dropped from the payload.
      bends.set(job.id, waypointsFor([], ports.source, ports.target, horizontal)[0]);
      continue;
    }
    placed.push(best.route);
    bends.set(job.id, best.waypoints.length === 1 ? best.waypoints[0] : best.waypoints);
  }

  return {
    placements: placements.map(({ entityId, parentEntityId, x, y, width, height }) => ({
      entityId,
      parentEntityId,
      x,
      y,
      width,
      height,
    })),
    connections: [...graph.connections]
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((connection) => {
        const bend = bends.get(connection.id);
        return bend ? [{ connectionId: connection.id, bend }] : [];
      }),
  };
}
