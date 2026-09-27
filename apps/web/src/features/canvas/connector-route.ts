import type { ConnectionBend, ConnectionPath } from "@wooble/domain";

export interface RouteSegment {
  from: ConnectionBend;
  to: ConnectionBend;
  insertIndex: number;
}

export function routeWaypoints(path: ConnectionPath): ConnectionBend[] {
  return Array.isArray(path) ? path : path ? [path] : [];
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

export function buildConnectorRoute(
  source: ConnectionBend,
  target: ConnectionBend,
  waypoints: ConnectionBend[],
  horizontal: boolean,
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
