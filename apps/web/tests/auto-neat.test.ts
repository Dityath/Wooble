import { expect, test } from "bun:test";
import type { CanvasGraph } from "../src/lib/api";
import { buildAutoNeatLayout } from "../src/features/canvas/auto-neat";
import { buildConnectorRoute } from "../src/features/canvas/connector-route";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function exampleGraph(): CanvasGraph {
  const placements = [
    { entityId: id(1), parentEntityId: null, x: 0, y: 0, width: 300, height: 300 },
    { entityId: id(2), parentEntityId: null, x: 340, y: 0, width: 300, height: 300 },
    { entityId: id(3), parentEntityId: id(1), x: 20, y: 100, width: 200, height: 120 },
    { entityId: id(4), parentEntityId: id(1), x: 30, y: 130, width: 200, height: 120 },
    { entityId: id(5), parentEntityId: id(2), x: 20, y: 100, width: 200, height: 120 },
    { entityId: id(6), parentEntityId: id(2), x: 30, y: 130, width: 200, height: 120 },
  ];
  return {
    canvas: { id: id(7), updatedAt: "2026-09-24T00:00:00.000Z" },
    entities: [1, 2, 3, 4, 5, 6].map((number) => ({ id: id(number), type: number < 3 ? "system" : "service" })),
    placements: placements.map((placement) => ({ ...placement, canvasId: id(7) })),
    connections: [
      { id: id(8), sourceEntityId: id(3), targetEntityId: id(5), bend: null },
      { id: id(9), sourceEntityId: id(3), targetEntityId: id(6), bend: null },
    ],
  } as CanvasGraph;
}

test("Auto Neat separates child nodes, systems, and shared connector paths", () => {
  const result = buildAutoNeatLayout(exampleGraph());
  const byId = new Map(result.placements.map((node) => [node.entityId, node]));
  const firstSystem = byId.get(id(1));
  const secondSystem = byId.get(id(2));
  const firstChild = byId.get(id(3));
  const secondChild = byId.get(id(4));

  if (!firstSystem || !secondSystem || !firstChild || !secondChild) throw new Error("Missing example placement");

  expect(secondSystem.x - (firstSystem.x + firstSystem.width)).toBeGreaterThanOrEqual(240);
  expect(secondChild.x - (firstChild.x + firstChild.width)).toBeGreaterThanOrEqual(80);
  expect(firstChild.parentEntityId).toBe(id(1));
  expect(firstSystem.width).toBeGreaterThanOrEqual(secondChild.x + secondChild.width + 48);
  expect(result.connections).toHaveLength(2);
  expect(result.connections[0]?.bend).not.toEqual(result.connections[1]?.bend);
});

test("Auto Neat yields the same layout when applied again", () => {
  const graph = exampleGraph();
  const first = buildAutoNeatLayout(graph);
  const again = buildAutoNeatLayout({
    ...graph,
    placements: first.placements.map((placement) => ({ ...placement, canvasId: graph.canvas.id })),
    connections: graph.connections.map((connection) => ({
      ...connection,
      bend: first.connections.find((item) => item.connectionId === connection.id)?.bend ?? null,
    })),
  });
  expect(again).toEqual(first);
});

test("Auto Neat places architecture types in horizontal hierarchy rows", () => {
  const types = [
    "system",
    "frontend",
    "device",
    "gateway",
    "service",
    "service",
    "service",
    "external",
    "database",
    "database",
    "broker",
  ];
  const graph = {
    ...exampleGraph(),
    entities: types.map((type, index) => ({ id: id(index + 1), type, name: `${type}-${index}` })),
    placements: types.map((_, index) => ({
      canvasId: id(20),
      entityId: id(index + 1),
      parentEntityId: index === 0 ? null : id(1),
      x: 0,
      y: 0,
      width: index === 0 ? 440 : 220,
      height: index === 0 ? 360 : 120,
    })),
    connections: [
      [2, 4],
      [4, 5],
      [4, 6],
      [4, 7],
      [4, 8],
      [5, 9],
      [7, 10],
      [8, 11],
    ].map(([source, target], index) => ({
      id: id(30 + index),
      sourceEntityId: id(source),
      targetEntityId: id(target),
      bend: null,
    })),
  } as CanvasGraph;
  const result = buildAutoNeatLayout(graph);
  const node = (number: number) => {
    const placement = result.placements.find((item) => item.entityId === id(number));
    if (!placement) throw new Error(`Missing node ${number}`);
    return placement;
  };
  expect(node(2).y).toBe(node(3).y);
  expect(node(4).y).toBeGreaterThan(node(2).y);
  expect([5, 6, 7, 8].map((number) => node(number).y)).toEqual([node(5).y, node(5).y, node(5).y, node(5).y]);
  expect(node(5).y).toBeGreaterThan(node(4).y);
  const middleRow = [5, 6, 7, 8].map(node).sort((a, b) => a.x - b.x);
  for (let index = 1; index < middleRow.length; index++)
    expect(middleRow[index].x - middleRow[index - 1].x - middleRow[index - 1].width).toBeGreaterThanOrEqual(120);
  expect([9, 10, 11].map((number) => node(number).y)).toEqual([node(9).y, node(9).y, node(9).y]);
  expect(node(9).y).toBeGreaterThan(node(5).y);
  expect(node(9).x).toBe(node(5).x);
  expect(node(10).x).toBe(node(7).x);
  expect(node(11).x).toBe(node(8).x);
  expect(node(1).width).toBeGreaterThanOrEqual(node(8).x + node(8).width + 64);
});

test("Auto Neat lines up three root system boxes", () => {
  const graph = {
    ...exampleGraph(),
    entities: [1, 2, 3].map((number) => ({ id: id(number), type: "system", name: `System ${number}` })),
    placements: [1, 2, 3].map((number) => ({
      canvasId: id(7),
      entityId: id(number),
      parentEntityId: null,
      x: 0,
      y: number * 500,
      width: 400,
      height: 300,
    })),
    connections: [],
    // Only the fields Auto Neat reads are filled in.
  } as unknown as CanvasGraph;
  const systems = buildAutoNeatLayout(graph).placements;
  expect(systems.map((system) => system.y)).toEqual([0, 0, 0]);
  expect(systems[1]?.x).toBeGreaterThan((systems[0]?.x ?? 0) + (systems[0]?.width ?? 0));
  expect(systems[2]?.x).toBeGreaterThan((systems[1]?.x ?? 0) + (systems[1]?.width ?? 0));
});

test("Auto Neat keeps the same hierarchy when nodes have no system box", () => {
  const graph = {
    ...exampleGraph(),
    entities: ["frontend", "gateway", "service", "service", "database"].map((type, index) => ({
      id: id(index + 1),
      type,
      name: `${type}-${index}`,
    })),
    placements: [1, 2, 3, 4, 5].map((number) => ({
      canvasId: id(7),
      entityId: id(number),
      parentEntityId: null,
      x: 0,
      y: 0,
      width: 220,
      height: 120,
    })),
    connections: [{ id: id(9), sourceEntityId: id(4), targetEntityId: id(5), bend: null }],
  } as CanvasGraph;
  const byId = new Map(buildAutoNeatLayout(graph).placements.map((placement) => [placement.entityId, placement]));
  const frontend = byId.get(id(1));
  const gateway = byId.get(id(2));
  const firstService = byId.get(id(3));
  const secondService = byId.get(id(4));
  const database = byId.get(id(5));
  if (!frontend || !gateway || !firstService || !secondService || !database) throw new Error("Missing root node");
  expect(frontend.y).toBeLessThan(gateway.y);
  expect(gateway.y).toBeLessThan(firstService.y);
  expect(firstService.y).toBe(secondService.y);
  expect(secondService.y).toBeLessThan(database.y);
  expect(database.x).toBe(secondService.x);
});

test("a single database sits below its service and a large system contracts around the flow", () => {
  const graph = {
    ...exampleGraph(),
    entities: [
      { id: id(1), name: "Example System", type: "system" },
      { id: id(2), name: "Example Frontend", type: "frontend" },
      { id: id(3), name: "Example Gateway", type: "gateway" },
      { id: id(4), name: "Integration Service", type: "service" },
      { id: id(5), name: "Master Service", type: "service" },
      { id: id(6), name: "Master Database", type: "database" },
    ],
    placements: [1, 2, 3, 4, 5, 6].map((number) => ({
      canvasId: id(7),
      entityId: id(number),
      parentEntityId: number === 1 ? null : id(1),
      x: number * 20,
      y: number * 20,
      width: number === 1 ? 900 : 270,
      height: number === 1 ? 1320 : 146,
    })),
    connections: [
      { id: id(11), sourceEntityId: id(2), targetEntityId: id(3), bend: null },
      { id: id(12), sourceEntityId: id(3), targetEntityId: id(4), bend: null },
      { id: id(13), sourceEntityId: id(3), targetEntityId: id(5), bend: null },
      { id: id(14), sourceEntityId: id(5), targetEntityId: id(6), bend: null },
    ],
  } as CanvasGraph;
  const result = buildAutoNeatLayout(graph);
  const nodes = new Map(result.placements.map((node) => [node.entityId, node]));
  const system = nodes.get(id(1));
  const frontend = nodes.get(id(2));
  const gateway = nodes.get(id(3));
  const master = nodes.get(id(5));
  const database = nodes.get(id(6));
  if (!system || !frontend || !gateway || !master || !database) throw new Error("Missing example placement");

  expect(frontend.x).toBe(gateway.x);
  expect(database.x).toBe(master.x);
  expect(database.y - (master.y + master.height)).toBe(110);
  expect(system.height).toBeLessThan(1320);
  const databaseLink = result.connections.find((connection) => connection.connectionId === id(14));
  expect(databaseLink?.bend.x).toBe(system.x + master.x + master.width / 2);
  if (!databaseLink) throw new Error("Missing database connection");
  const route = buildConnectorRoute(
    { x: system.x + master.x + master.width / 2, y: system.y + master.y + master.height },
    { x: system.x + database.x + database.width / 2, y: system.y + database.y },
    [databaseLink.bend],
    false,
  );
  expect(route.segments.every(({ from, to }) => from.x === to.x)).toBe(true);
});

test("layered systems keep service databases aligned and route long links around cards", () => {
  const names = [
    "Core Identity",
    "Operations Platform",
    "Identity Console",
    "Identity API Gateway",
    "Auth Service",
    "Master Service",
    "Auth Database",
    "Master Database",
    "Operations Portal",
    "Operations Gateway",
    "Permit Service",
    "Session Service",
    "Permit Store",
    "Session Store",
  ];
  const types = [
    "system",
    "system",
    "frontend",
    "gateway",
    "service",
    "service",
    "database",
    "database",
    "frontend",
    "gateway",
    "service",
    "service",
    "database",
    "database",
  ];
  const parent = (number: number) => (number < 3 ? null : number < 9 ? id(1) : id(2));
  const links: Array<[number, number]> = [
    [3, 4],
    [4, 5],
    [4, 6],
    [5, 6],
    [5, 7],
    [6, 8],
    [9, 10],
    [10, 11],
    [10, 12],
    [11, 12],
    [11, 13],
    [12, 14],
    [4, 10],
    [5, 11],
  ];
  const graph = {
    ...exampleGraph(),
    entities: names.map((name, index) => ({ id: id(index + 1), name, type: types[index] })),
    placements: names.map((_, index) => ({
      canvasId: id(20),
      entityId: id(index + 1),
      parentEntityId: parent(index + 1),
      x: index * 4,
      y: index * 8,
      width: index < 2 ? 440 : 220,
      height: index < 2 ? 400 : 120,
    })),
    connections: links.map(([source, target], index) => ({
      id: id(30 + index),
      sourceEntityId: id(source),
      targetEntityId: id(target),
      bend: null,
    })),
  } as CanvasGraph;
  const result = buildAutoNeatLayout(graph);
  const nodes = new Map(result.placements.map((placement) => [placement.entityId, placement]));
  const auth = nodes.get(id(5));
  const master = nodes.get(id(6));
  const authDatabase = nodes.get(id(7));
  const gateway = nodes.get(id(4));
  if (!auth || !master || !authDatabase || !gateway) throw new Error("Missing layered placement");
  expect(gateway.y + gateway.height).toBeLessThan(auth.y);
  expect(auth.x).toBe(authDatabase.x);
  const longLink = result.connections.find((connection) => connection.connectionId === id(43));
  if (!longLink) throw new Error("Missing cross-system link");
  expect(longLink.bend.x).toBeGreaterThan(auth.x + auth.width);
  expect(longLink.bend.x).toBeLessThan(master.x);
  expect(longLink.bend.y).toBeGreaterThan(master.y + master.height);
  expect(longLink.bend.y).toBeLessThan(authDatabase.y);
  const gatewayBranches = result.connections.filter((connection) => [id(31), id(32)].includes(connection.connectionId));
  expect(gatewayBranches[0]?.bend.y).not.toBe(gatewayBranches[1]?.bend.y);

  const cards = result.placements.filter((placement) => placement.parentEntityId);
  const absolute = (number: number) => {
    const node = nodes.get(id(number));
    if (!node) throw new Error(`Missing node ${number}`);
    const system = node.parentEntityId ? nodes.get(node.parentEntityId) : null;
    return { x: node.x + (system?.x ?? 0), y: node.y + (system?.y ?? 0), width: node.width, height: node.height };
  };
  const collisions: string[] = [];
  links.forEach(([sourceNumber, targetNumber], index) => {
    const source = absolute(sourceNumber);
    const target = absolute(targetNumber);
    const bend = result.connections.find((connection) => connection.connectionId === id(30 + index))?.bend;
    if (!bend) throw new Error("Missing connector bend");
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height / 2;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height / 2;
    const horizontal = Math.abs(tx - sx) > Math.abs(ty - sy);
    const direction = horizontal ? (tx >= sx ? 1 : -1) : ty >= sy ? 1 : -1;
    const points = horizontal
      ? [
          { x: sx + (direction * source.width) / 2, y: sy },
          { x: bend.x, y: sy },
          bend,
          { x: tx - (direction * target.width) / 2, y: bend.y },
          { x: tx - (direction * target.width) / 2, y: ty },
        ]
      : [
          { x: sx, y: sy + (direction * source.height) / 2 },
          { x: sx, y: bend.y },
          bend,
          { x: bend.x, y: ty - (direction * target.height) / 2 },
          { x: tx, y: ty - (direction * target.height) / 2 },
        ];
    for (const card of cards) {
      if (card.entityId === id(sourceNumber) || card.entityId === id(targetNumber)) continue;
      const rect = absolute(Number(card.entityId.slice(-12)));
      for (let segment = 0; segment < points.length - 1; segment++) {
        const a = points[segment];
        const b = points[segment + 1];
        const crosses =
          a.x === b.x
            ? a.x > rect.x + 2 &&
              a.x < rect.x + rect.width - 2 &&
              Math.max(a.y, b.y) > rect.y + 2 &&
              Math.min(a.y, b.y) < rect.y + rect.height - 2
            : a.y > rect.y + 2 &&
              a.y < rect.y + rect.height - 2 &&
              Math.max(a.x, b.x) > rect.x + 2 &&
              Math.min(a.x, b.x) < rect.x + rect.width - 2;
        if (crosses) collisions.push(`${sourceNumber}->${targetNumber} crosses ${card.entityId}`);
      }
    }
  });
  expect(collisions).toEqual([]);
});
