import type { ConnectionBend, ConnectionPath } from "@wooble/domain";

export interface RouteSegment {
  from: ConnectionBend;
  to: ConnectionBend;
  insertIndex: number;
}

export function routeWaypoints(path: ConnectionPath): ConnectionBend[] {
  return Array.isArray(path) ? path : path ? [path] : [];
}

export type ConnectorSide = "left" | "right" | "top" | "bottom";
export interface ConnectorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxPlacement extends ConnectorBox {
  entityId: string;
  parentEntityId?: string | null;
}

// Absolute box of a placement: walks the whole parent chain (cycle-safe) so nested systems resolve identically everywhere.
export function absoluteBox(placement: BoxPlacement, byId: Map<string, BoxPlacement>): ConnectorBox {
  let { x, y } = placement;
  let parentId = placement.parentEntityId;
  const seen = new Set([placement.entityId]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.x;
    y += parent.y;
    parentId = parent.parentEntityId;
  }
  return { x, y, width: placement.width, height: placement.height };
}

// The handle sits mid-side; a port shifts the attachment along the side by its offset.
export const applyPortOffset = (handle: ConnectionBend, offset?: ConnectionBend): ConnectionBend => ({
  x: handle.x + (offset?.x ?? 0),
  y: handle.y + (offset?.y ?? 0),
});

// True when any leg runs through the interior of the source or target card (legs along or leaving the attachment edge are fine).
export function routeEntersEndpoints(
  segments: Array<{ from: ConnectionBend; to: ConnectionBend }>,
  sourceBox: ConnectorBox,
  targetBox: ConnectorBox,
): boolean {
  return [sourceBox, targetBox].some((box) =>
    segments.some(({ from, to }) => {
      return (
        Math.min(from.x, to.x) < box.x + box.width &&
        Math.max(from.x, to.x) > box.x &&
        Math.min(from.y, to.y) < box.y + box.height &&
        Math.max(from.y, to.y) > box.y
      );
    }),
  );
}

const tx = (box: ConnectorBox) => box.x + box.width / 2;

// Sides depend on geometry only, so swapping source and target gives the mirrored sides (the same picture).
// Horizontal-dominant links in different rows leave the upper box's side and drop into the lower box's top (an "L").
export function connectionSides(
  source: ConnectorBox,
  target: ConnectorBox,
): { sourceSide: ConnectorSide; targetSide: ConnectorSide } {
  const dx = tx(target) - tx(source);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  // A target centred over (or under) the source, or the reverse, would make the L's drop run through the source: keep it vertical.
  const overlapsX =
    (tx(target) >= source.x && tx(target) <= source.x + source.width) ||
    (tx(source) >= target.x && tx(source) <= target.x + target.width);
  if (Math.abs(dx) > Math.abs(dy) && !overlapsX) {
    const sourceUpper = target.y >= source.y + source.height;
    const targetUpper = source.y >= target.y + target.height;
    if (sourceUpper) return { sourceSide: dx > 0 ? "right" : "left", targetSide: "top" };
    if (targetUpper) return { sourceSide: "top", targetSide: dx > 0 ? "left" : "right" };
    return { sourceSide: dx > 0 ? "right" : "left", targetSide: dx > 0 ? "left" : "right" };
  }
  return { sourceSide: dy > 0 ? "bottom" : "top", targetSide: dy > 0 ? "top" : "bottom" };
}

export function isHorizontalRoute(
  sourceHandleId: string | null | undefined,
  source: ConnectionBend,
  target: ConnectionBend,
) {
  if (sourceHandleId === "source-left" || sourceHandleId === "source-right") return true;
  if (sourceHandleId === "source-top" || sourceHandleId === "source-bottom") return false;
  return Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
}

const APPROACH = 22;
const MIN_APPROACH = 4;

export function buildConnectorRoute(
  source: ConnectionBend,
  target: ConnectionBend,
  waypoints: ConnectionBend[],
  horizontal: boolean,
  targetSide?: ConnectorSide,
) {
  const segments: RouteSegment[] = [];
  let current = source;
  const add = (to: ConnectionBend, insertIndex: number) => {
    if (to.x === current.x && to.y === current.y) return;
    segments.push({ from: current, to, insertIndex });
    current = to;
  };
  waypoints.forEach((point, index) => {
    if (horizontal) add({ x: point.x, y: current.y }, index);
    else add({ x: current.x, y: point.y }, index);
    add(point, index);
  });
  // A top/bottom target must be entered by a vertical leg from outside its card; detour legacy bends that sit beside it.
  const sign = targetSide === "top" ? -1 : targetSide === "bottom" ? 1 : 0;
  if (horizontal && sign && (current.y - target.y) * sign < MIN_APPROACH) {
    const approachY = target.y + sign * APPROACH;
    add({ x: current.x, y: approachY }, waypoints.length);
    add({ x: target.x, y: approachY }, waypoints.length);
  }
  if (horizontal) add({ x: target.x, y: current.y }, waypoints.length);
  else add({ x: current.x, y: target.y }, waypoints.length);
  add(target, waypoints.length);

  const path = `M ${source.x} ${source.y} ${segments.map(({ to }) => `L ${to.x} ${to.y}`).join(" ")}`;
  const length = (segment: RouteSegment) =>
    Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y);
  let remaining = segments.reduce((total, segment) => total + length(segment), 0) / 2;
  let label = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  for (const segment of segments) {
    const segmentLength = length(segment);
    if (remaining <= segmentLength) {
      const share = segmentLength === 0 ? 0 : remaining / segmentLength;
      label = {
        x: segment.from.x + (segment.to.x - segment.from.x) * share,
        y: segment.from.y + (segment.to.y - segment.from.y) * share,
      };
      break;
    }
    remaining -= segmentLength;
  }
  return { path, label, segments };
}

export function closestRouteInsertion(segments: RouteSegment[], point: ConnectionBend): number {
  let closest = { distance: Number.POSITIVE_INFINITY, index: 0 };
  for (const segment of segments) {
    const x = Math.max(
      Math.min(point.x, Math.max(segment.from.x, segment.to.x)),
      Math.min(segment.from.x, segment.to.x),
    );
    const y = Math.max(
      Math.min(point.y, Math.max(segment.from.y, segment.to.y)),
      Math.min(segment.from.y, segment.to.y),
    );
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (distance < closest.distance) closest = { distance, index: segment.insertIndex };
  }
  return closest.index;
}
