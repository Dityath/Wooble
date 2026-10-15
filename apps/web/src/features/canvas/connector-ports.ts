import { type ConnectorBox, type ConnectorSide, connectionSides } from "./connector-route";

export interface PortConnection {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
}
export interface ConnectorPoint {
  x: number;
  y: number;
}
export interface ConnectorPorts {
  sourceSide: ConnectorSide;
  targetSide: ConnectorSide;
  /** Absolute attachment points. */
  source: ConnectorPoint;
  target: ConnectorPoint;
  /** Offsets of the points from the middle of their side (where the node's handle sits). */
  sourceOffset: ConnectorPoint;
  targetOffset: ConnectorPoint;
}

interface Attachment {
  id: string;
  end: "source" | "target";
  box: ConnectorBox;
  side: ConnectorSide;
  other: ConnectorBox;
  otherSide: ConnectorSide;
}

const cx = (box: ConnectorBox) => box.x + box.width / 2;
const cy = (box: ConnectorBox) => box.y + box.height / 2;

// Sort key per attachment; attachments on one side are ordered by (group, key, id), first = top / left.
function orderKey({ box, side, other, otherSide }: Attachment): [number, number] {
  if (side === "left" || side === "right") {
    // Same-row links first (nearest the top), then down-going Ls: farther = higher so the nested runs never cross.
    if (otherSide === "left" || otherSide === "right") return [0, cy(other)];
    return [1, -Math.abs(cx(other) - cx(box))];
  }
  if (side === "top") {
    // Straight links sit in the middle. An L from the left: nearer = lower run = further left. Mirrored from the right.
    if (otherSide === "bottom") return [1, cx(other)];
    return otherSide === "right" ? [0, -cx(other)] : [2, -cx(other)];
  }
  return [0, cx(other)];
}

// Only the position along the side differs from the handle's middle.
const offsetOf = (point: ConnectorPoint, box: ConnectorBox, side: ConnectorSide): ConnectorPoint =>
  side === "left" || side === "right" ? { x: 0, y: point.y - cy(box) } : { x: point.x - cx(box), y: 0 };

// Whole pixels, so ports and the waypoints computed from them agree.
const sidePoint = (box: ConnectorBox, side: ConnectorSide, share: number): ConnectorPoint =>
  side === "left" || side === "right"
    ? { x: side === "left" ? box.x : box.x + box.width, y: Math.round(box.y + box.height * share) }
    : { x: Math.round(box.x + box.width * share), y: side === "top" ? box.y : box.y + box.height };

export function connectorPorts(
  boxes: Map<string, ConnectorBox>,
  connections: PortConnection[],
): Map<string, ConnectorPorts> {
  const points = new Map<string, ConnectorPoint>();
  const sides = new Map<string, { sourceSide: ConnectorSide; targetSide: ConnectorSide }>();
  const groups = new Map<string, Attachment[]>();
  const attach = (attachment: Attachment, nodeId: string) => {
    const key = `${nodeId}:${attachment.side}`;
    groups.set(key, [...(groups.get(key) ?? []), attachment]);
  };
  for (const connection of connections) {
    const source = boxes.get(connection.sourceEntityId);
    const target = boxes.get(connection.targetEntityId);
    if (!source || !target) continue;
    const pair = connectionSides(source, target);
    sides.set(connection.id, pair);
    if (connection.sourceEntityId === connection.targetEntityId) {
      // Self-links do not share sides with other connectors: keep them centred.
      points.set(`${connection.id}:source`, sidePoint(source, pair.sourceSide, 0.5));
      points.set(`${connection.id}:target`, sidePoint(target, pair.targetSide, 0.5));
      continue;
    }
    attach(
      {
        id: connection.id,
        end: "source",
        box: source,
        side: pair.sourceSide,
        other: target,
        otherSide: pair.targetSide,
      },
      connection.sourceEntityId,
    );
    attach(
      {
        id: connection.id,
        end: "target",
        box: target,
        side: pair.targetSide,
        other: source,
        otherSide: pair.sourceSide,
      },
      connection.targetEntityId,
    );
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const [groupA, keyA] = orderKey(a);
      const [groupB, keyB] = orderKey(b);
      return groupA - groupB || keyA - keyB || a.id.localeCompare(b.id) || a.end.localeCompare(b.end);
    });
    group.forEach(({ id, end, box, side }, index) => {
      const share = (index + 1) / (group.length + 1);
      points.set(`${id}:${end}`, sidePoint(box, side, share));
    });
  }
  const result = new Map<string, ConnectorPorts>();
  for (const connection of connections) {
    const pair = sides.get(connection.id);
    const source = points.get(`${connection.id}:source`);
    const target = points.get(`${connection.id}:target`);
    const sourceBox = boxes.get(connection.sourceEntityId);
    const targetBox = boxes.get(connection.targetEntityId);
    if (!pair || !source || !target || !sourceBox || !targetBox) continue;
    result.set(connection.id, {
      ...pair,
      source,
      target,
      sourceOffset: offsetOf(source, sourceBox, pair.sourceSide),
      targetOffset: offsetOf(target, targetBox, pair.targetSide),
    });
  }
  return result;
}
