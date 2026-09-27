import type { CanvasNode, ConnectionBend } from "@wooble/domain";
import type { CanvasGraph } from "../../lib/api";

export interface AutoNeatLayout {
  placements: Array<Omit<CanvasNode, "canvasId">>;
  connections: Array<{ connectionId: string; bend: ConnectionBend }>;
}

const NODE_GAP_X = 120;
const NODE_GAP_Y = 110;
const SYSTEM_GAP_X = 300;
const SYSTEM_PADDING_X = 64;
const SYSTEM_PADDING_TOP = 112;
const SYSTEM_PADDING_BOTTOM = 48;

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

  const absolute = (node: CanvasNode) => {
    let x = node.x;
    let y = node.y;
    let parentId = node.parentEntityId;
    const seen = new Set([node.entityId]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      x += parent.x;
      y += parent.y;
      parentId = parent.parentEntityId;
    }
    return { x, y };
  };
  const lanes = new Map<string, number>();
  const cards = placements.filter((placement) => !systemIds.has(placement.entityId));
  const connections = [...graph.connections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((connection) => {
      const source = byId.get(connection.sourceEntityId);
      const target = byId.get(connection.targetEntityId);
      if (!source || !target)
        return {
          connectionId: connection.id,
          bend: (Array.isArray(connection.bend) ? connection.bend[0] : connection.bend) ?? { x: 0, y: 0 },
        };
      const sourcePosition = absolute(source);
      const targetPosition = absolute(target);
      const sx = sourcePosition.x + source.width / 2;
      const sy = sourcePosition.y + source.height / 2;
      const tx = targetPosition.x + target.width / 2;
      const ty = targetPosition.y + target.height / 2;
      const horizontal = Math.abs(tx - sx) > Math.abs(ty - sy);
      const direction = horizontal ? (tx >= sx ? 1 : -1) : ty >= sy ? 1 : -1;
      const laneKey = `${connection.sourceEntityId}:${horizontal ? "horizontal" : "vertical"}:${direction}`;
      const lane = lanes.get(laneKey) ?? 0;
      lanes.set(laneKey, lane + 1);
      let bend: ConnectionBend;
      if (horizontal) {
        const sourcePort = sx + (direction * source.width) / 2;
        const targetPort = tx - (direction * target.width) / 2;
        const left = Math.min(sourcePort, targetPort);
        const right = Math.max(sourcePort, targetPort);
        const obstacles = cards.filter((card) => {
          if (card.entityId === source.entityId || card.entityId === target.entityId) return false;
          const position = absolute(card);
          return (
            position.x < right && position.x + card.width > left && position.y < sy && position.y + card.height > sy
          );
        });
        if (obstacles.length) {
          // Leave the source through its neighboring gutter, then cross below the occupied row.
          const bottom = Math.max(
            sourcePosition.y + source.height,
            targetPosition.y + target.height,
            ...obstacles.map((card) => absolute(card).y + card.height),
          );
          bend = { x: Math.round(sourcePort + direction * 55), y: Math.round(bottom + 55 + lane * 30) };
        } else {
          bend = { x: Math.round((sourcePort + targetPort) / 2), y: Math.round(ty) };
        }
      } else {
        const sourcePort = sy + (direction * source.height) / 2;
        const targetPort = ty - (direction * target.height) / 2;
        const midpoint = (sourcePort + targetPort) / 2;
        const space = Math.abs(targetPort - sourcePort);
        const spread = Math.min(26, Math.max(0, (space - 50) / 4));
        const stagger = lane === 0 ? -spread : lane === 1 ? spread : (lane - 1) * spread;
        bend = { x: Math.round(tx), y: Math.round(midpoint + direction * stagger) };
      }
      return { connectionId: connection.id, bend };
    });

  return {
    placements: placements.map(({ entityId, parentEntityId, x, y, width, height }) => ({
      entityId,
      parentEntityId,
      x,
      y,
      width,
      height,
    })),
    connections,
  };
}
