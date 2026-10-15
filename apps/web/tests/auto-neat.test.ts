import { expect, test } from "bun:test";
import type { ConnectionBend } from "@wooble/domain";
import type { CanvasGraph } from "../src/lib/api";
import { connectionTitle } from "../src/lib/connection-title";
import { buildAutoNeatLayout } from "../src/features/canvas/auto-neat";
import { connectorPorts } from "../src/features/canvas/connector-ports";
import { buildConnectorRoute, routeWaypoints } from "../src/features/canvas/connector-route";
import { type EdgeLabelSize, edgeLabelBox, edgeLabelSize, placeEdgeLabels } from "../src/features/canvas/edge-label";

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
      { id: id(8), sourceEntityId: id(3), targetEntityId: id(5), bend: null, label: "", type: "rest" },
      { id: id(9), sourceEntityId: id(3), targetEntityId: id(6), bend: null, label: "", type: "rest" },
    ],
  } as CanvasGraph;
}

test("Auto Neat separates child nodes, systems, and shared connector paths", () => {
  const graph = exampleGraph();
  const result = buildAutoNeatLayout(graph);
  // Cross-system links render clear of cards and of each other, from two distinct ports on the shared source card.
  expectClearRoutes(graph);
  const [first, second] = renderRoutes(graph, result).routes;
  expect(first.port.source).not.toEqual(second.port.source);
  expect(first.port.target).not.toEqual(second.port.target);
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

// Feeds Auto Neat's own output back in as the canvas state.
function applyAgain(graph: CanvasGraph) {
  const first = buildAutoNeatLayout(graph);
  const again = buildAutoNeatLayout({
    ...graph,
    placements: first.placements.map((placement) => ({ ...placement, canvasId: graph.canvas.id })),
    connections: graph.connections.map((connection) => ({
      ...connection,
      bend: first.connections.find((item) => item.connectionId === connection.id)?.bend ?? null,
    })),
  });
  return { first, again };
}

test("Auto Neat yields the same layout when applied again", () => {
  const { first, again } = applyAgain(exampleGraph());
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
      label: "",
      type: "rest",
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
    connections: [{ id: id(9), sourceEntityId: id(4), targetEntityId: id(5), bend: null, label: "", type: "rest" }],
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
      { id: id(11), sourceEntityId: id(2), targetEntityId: id(3), bend: null, label: "", type: "rest" },
      { id: id(12), sourceEntityId: id(3), targetEntityId: id(4), bend: null, label: "", type: "rest" },
      { id: id(13), sourceEntityId: id(3), targetEntityId: id(5), bend: null, label: "", type: "rest" },
      { id: id(14), sourceEntityId: id(5), targetEntityId: id(6), bend: null, label: "", type: "rest" },
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
  expect((databaseLink?.bend as ConnectionBend | undefined)?.x).toBe(system.x + master.x + master.width / 2);
  const route = renderRoutes(graph, result).routes.find((item) => item.connection.id === id(14));
  if (!route) throw new Error("Missing database route");
  expect(route.port.sourceSide).toBe("bottom");
  expect(route.port.targetSide).toBe("top");
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
      label: "",
      type: "rest",
    })),
  } as CanvasGraph;
  const result = buildAutoNeatLayout(graph);
  const nodes = new Map(result.placements.map((placement) => [placement.entityId, placement]));
  const auth = nodes.get(id(5));
  const authDatabase = nodes.get(id(7));
  const gateway = nodes.get(id(4));
  if (!auth || !authDatabase || !gateway) throw new Error("Missing layered placement");
  expect(gateway.y + gateway.height).toBeLessThan(auth.y);
  expect(auth.x).toBe(authDatabase.x);
  expect(result.connections).toHaveLength(links.length);
  // Cross-system links may be forced to touch others here, but no route may cross a card or sit on a label.
  const rendered = renderRoutes(graph, result);
  expect(cardProblems(graph, rendered)).toEqual([]);
  // Only the two cross-system links may be forced into a touch (currently one); labels never collide.
  const crossSystem = ["Identity API Gateway->Operations Gateway", "Auth Service->Permit Service"];
  const pairs = pairProblems(graph, rendered);
  expect(pairs.length).toBeLessThanOrEqual(2);
  for (const problem of pairs) {
    expect(problem.endsWith(" touch")).toBe(true);
    expect(crossSystem.some((name) => problem.includes(name))).toBe(true);
  }
});

type Card = { number: number; name: string; type: string };

function systemGraph(cards: Card[], links: Array<[number, number]>): CanvasGraph {
  return {
    canvas: { id: id(900), updatedAt: "2026-09-24T00:00:00.000Z" },
    entities: [{ id: id(100), name: "System", type: "system" }, ...cards.map((c) => ({ id: id(c.number), ...c }))],
    placements: [
      { canvasId: id(900), entityId: id(100), parentEntityId: null, x: 0, y: 0, width: 2000, height: 1200 },
      ...cards.map((c) => ({
        canvasId: id(900),
        entityId: id(c.number),
        parentEntityId: id(100),
        x: 0,
        y: 0,
        width: 250,
        height: 135,
      })),
    ],
    connections: links.map(([source, target], index) => ({
      id: id(200 + index),
      sourceEntityId: id(source),
      targetEntityId: id(target),
      bend: null,
      label: "",
      type: "rest",
    })),
  } as unknown as CanvasGraph;
}

// Shared geometry: boxes, segments, and the three user rules.
type Pt = { x: number; y: number };
type Seg = { from: Pt; to: Pt };
type Rect = { left: number; top: number; right: number; bottom: number };
const rectOf = (n: { x: number; y: number; width: number; height: number }): Rect => ({
  left: n.x,
  top: n.y,
  right: n.x + n.width,
  bottom: n.y + n.height,
});
const rectsOverlap = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const grow = (r: Rect, pad: number): Rect => ({
  left: r.left - pad,
  top: r.top - pad,
  right: r.right + pad,
  bottom: r.bottom + pad,
});
const segRect = ({ from, to }: Seg): Rect => ({
  left: Math.min(from.x, to.x),
  right: Math.max(from.x, to.x),
  top: Math.min(from.y, to.y),
  bottom: Math.max(from.y, to.y),
});
const labelRect = (p: Pt, size: EdgeLabelSize): Rect => edgeLabelBox(p, size);

// Parallel connector segments closer than this overlap visually.
const MIN_PARALLEL_GAP = 8;
const isPoint = ({ from, to }: Seg) => from.x === to.x && from.y === to.y;

// Crossing or touching segments, collinear ones meeting end to end, or parallel ones closer than MIN_PARALLEL_GAP that overlap.
function segmentsClash(a: Seg, b: Seg) {
  // A zero-length segment has no orientation; the neighbouring segments of its route carry the geometry.
  if (isPoint(a) || isPoint(b)) return false;
  const ra = segRect(a);
  const rb = segRect(b);
  const aVertical = a.from.x === a.to.x;
  if (aVertical === (b.from.x === b.to.x)) {
    // Overlapping or end-to-end (shared endpoint) along the same line counts.
    return aVertical
      ? Math.abs(a.from.x - b.from.x) < MIN_PARALLEL_GAP && Math.min(ra.bottom, rb.bottom) >= Math.max(ra.top, rb.top)
      : Math.abs(a.from.y - b.from.y) < MIN_PARALLEL_GAP && Math.min(ra.right, rb.right) >= Math.max(ra.left, rb.left);
  }
  const [v, h] = aVertical ? [ra, rb] : [rb, ra];
  return v.left >= h.left && v.left <= h.right && h.top >= v.top && h.top <= v.bottom;
}

// Routes every connection exactly as the renderer does (connectorPorts + buildConnectorRoute + label anchors).
function renderRoutes(graph: CanvasGraph, layout = buildAutoNeatLayout(graph)) {
  const nodes = new Map(layout.placements.map((node) => [node.entityId, node]));
  const absolute = (entityId: string) => {
    const node = nodes.get(entityId);
    if (!node) throw new Error("Missing placement");
    const parent = node.parentEntityId ? nodes.get(node.parentEntityId) : null;
    return { ...node, x: node.x + (parent?.x ?? 0), y: node.y + (parent?.y ?? 0) };
  };
  const ports = connectorPorts(new Map(layout.placements.map((n) => [n.entityId, absolute(n.entityId)])), [
    ...graph.connections,
  ]);
  const systemIds = new Set(graph.entities.filter((e) => e.type === "system").map((e) => e.id));
  const cards = layout.placements
    .filter((n) => !systemIds.has(n.entityId))
    .map((n) => ({ id: n.entityId, ...absolute(n.entityId) }));
  const drawn = graph.connections.map((connection) => {
    const port = ports.get(connection.id);
    const bend = layout.connections.find((item) => item.connectionId === connection.id)?.bend;
    if (!port || !bend) throw new Error("Missing route inputs");
    const horizontal = port.sourceSide === "left" || port.sourceSide === "right";
    const { segments, label } = buildConnectorRoute(
      port.source,
      port.target,
      routeWaypoints(bend),
      horizontal,
      port.targetSide,
    );
    const points = segments.flatMap(({ from, to }, index) => (index === 0 ? [from, to] : [to]));
    return { connection, port, bend, segments, label, points, labelSize: edgeLabelSize(connectionTitle(connection)) };
  });
  // buildFlowEdges resolves anchors the same way, so the assertions read the label the user sees.
  const anchors = placeEdgeLabels(
    drawn.map((route) => ({ id: route.connection.id, segments: route.segments, size: route.labelSize })),
  );
  const routes = drawn.map((route) => ({
    ...route,
    label: anchors.get(route.connection.id) ?? route.label,
  }));
  return { routes, cards, absolute, nodes };
}

type Rendered = ReturnType<typeof renderRoutes>;
type RenderedRoute = Rendered["routes"][number];

const describe = (graph: CanvasGraph, route: RenderedRoute) => {
  const name = (entityId: string) =>
    (graph.entities.find((e) => e.id === entityId) as { name?: string } | undefined)?.name || entityId;
  return `${name(route.connection.sourceEntityId)}->${name(route.connection.targetEntityId)}`;
};

function cardProblems(graph: CanvasGraph, { routes, cards }: Rendered) {
  const problems: string[] = [];
  for (const route of routes)
    for (const card of cards) {
      const own = [route.connection.sourceEntityId, route.connection.targetEntityId].includes(card.id);
      const area = own ? rectOf(card) : grow(rectOf(card), 8);
      if (route.segments.some((segment) => rectsOverlap(segRect(segment), area)))
        problems.push(`${describe(graph, route)} hits card ${card.id}`);
      if (rectsOverlap(labelRect(route.label, route.labelSize), rectOf(card)))
        problems.push(`${describe(graph, route)} label on card ${card.id}`);
    }
  return problems;
}

function pairProblems(graph: CanvasGraph, { routes }: Rendered) {
  const problems: string[] = [];
  routes.forEach((a, index) => {
    for (const b of routes.slice(index + 1)) {
      const pair = `${describe(graph, a)} x ${describe(graph, b)}`;
      if (a.segments.some((s) => b.segments.some((t) => segmentsClash(s, t)))) problems.push(`${pair} touch`);
      if (rectsOverlap(labelRect(a.label, a.labelSize), labelRect(b.label, b.labelSize)))
        problems.push(`${pair} labels overlap`);
      if (b.segments.some((s) => rectsOverlap(segRect(s), labelRect(a.label, a.labelSize))))
        problems.push(`${describe(graph, a)} label covered by ${describe(graph, b)}`);
      if (a.segments.some((s) => rectsOverlap(segRect(s), labelRect(b.label, b.labelSize))))
        problems.push(`${describe(graph, b)} label covered by ${describe(graph, a)}`);
    }
  });
  return problems;
}

// The three user rules. `toleratedTouches` lists connector pairs ("A->B", "C->D") whose unavoidable touch is accepted;
// card hits, label problems, and every other pair must stay clean. Returns the touches actually tolerated.
function expectClearRoutes(graph: CanvasGraph, toleratedTouches: Array<[string, string]> = []) {
  const rendered = renderRoutes(graph);
  const isTolerated = (problem: string) =>
    toleratedTouches.some(([x, y]) => problem === `${x} x ${y} touch` || problem === `${y} x ${x} touch`);
  const problems = [...cardProblems(graph, rendered), ...pairProblems(graph, rendered)];
  expect(problems.filter((problem) => !isTolerated(problem))).toEqual([]);
  return { routes: rendered.routes, tolerated: problems.filter(isTolerated) };
}

const routeBetween = (graph: CanvasGraph, routes: RenderedRoute[], from: string, to: string) => {
  const found = routes.find((route) => [`${from}->${to}`, `${to}->${from}`].includes(describe(graph, route)));
  if (!found) throw new Error(`Missing route ${from} - ${to}`);
  return found;
};

const typed = (name: string, number: number, type: string): Card => ({ number, name, type });

// Stored with the service as the source (as in the user's canvas), or reversed.
const userCards: Card[] = [
  typed("Frontend", 1, "frontend"),
  typed("Gateway", 2, "gateway"),
  typed("Auth", 3, "service"),
  typed("IAM", 4, "service"),
  typed("Report", 5, "service"),
  typed("IAM DB", 6, "database"),
  typed("Report DB", 7, "database"),
];
const userLinks: Array<[number, number]> = [
  [1, 2],
  [3, 2],
  [4, 2],
  [5, 2],
  [4, 6],
  [5, 7],
];
const reversed = (links: Array<[number, number]>) =>
  links.map(([source, target]) => [target, source] as [number, number]);

const nineCards: Card[] = [
  typed("Frontend", 1, "frontend"),
  typed("Gateway", 2, "gateway"),
  typed("A new node 1", 3, "service"),
  typed("A new node 2", 4, "service"),
  typed("Auth", 5, "service"),
  typed("IAM", 6, "service"),
  typed("Report", 7, "service"),
  typed("IAM DB", 8, "database"),
  typed("Report DB", 9, "database"),
];
const nineLinks: Array<[number, number]> = [
  [1, 2],
  [5, 2],
  [6, 2],
  [7, 2],
  [6, 8],
  [7, 9],
];

const straight = (points: Pt[]) => points.every((point) => point.x === points[0].x);

// The route's polyline starting at the Gateway, whichever way the connection is stored.
function fromGateway(graph: CanvasGraph, routes: RenderedRoute[], name: string) {
  const gateway = graph.entities.find((e) => (e as { name?: string }).name === "Gateway")?.id;
  const route = routeBetween(graph, routes, "Gateway", name);
  return route.connection.sourceEntityId === gateway ? route.points : [...route.points].reverse();
}

// Leaves a gateway side, runs level, then drops straight into the top of the card.
function expectSideThenDrop(points: Pt[]) {
  const last = points.at(-1);
  const before = points.at(-2);
  expect(Math.abs(points[1].y - points[0].y)).toBeLessThanOrEqual(1);
  expect(Math.abs((before?.x ?? -1) - (last?.x ?? -2))).toBeLessThanOrEqual(1);
  expect(before?.y).toBeLessThan(last?.y ?? 0);
}

test("Auto Neat keeps the user's canvas clear of cards, other connectors and label collisions", () => {
  const graph = systemGraph(userCards, userLinks);
  const { routes } = expectClearRoutes(graph);
  // The gateway sits over IAM, so IAM is straight down and Auth and Report drop into their tops from opposite sides.
  expect(straight(fromGateway(graph, routes, "IAM"))).toBe(true);
  const auth = fromGateway(graph, routes, "Auth");
  const report = fromGateway(graph, routes, "Report");
  expectSideThenDrop(auth);
  expectSideThenDrop(report);
  expect(auth[1].x).toBeLessThan(auth[0].x);
  expect(report[1].x).toBeGreaterThan(report[0].x);
});

test("Auto Neat gives the same polylines when every connection is stored in the other direction", () => {
  const forward = systemGraph(userCards, userLinks);
  const backward = systemGraph(userCards, reversed(userLinks));
  const first = renderRoutes(forward).routes;
  expectClearRoutes(backward);
  const second = renderRoutes(backward).routes;
  first.forEach((route, index) => {
    expect(second[index].points).toEqual([...route.points].reverse());
  });
});

test("Auto Neat fans nested runs out of the gateway side at distinct points and drops into each service's top", () => {
  const graph = systemGraph(nineCards, nineLinks);
  const { routes } = expectClearRoutes(graph);
  expect(straight(fromGateway(graph, routes, "Auth"))).toBe(true);
  const iam = fromGateway(graph, routes, "IAM");
  const report = fromGateway(graph, routes, "Report");
  // Both leave the gateway's right side at different heights, Report's run above IAM's, and end straight down into a top.
  expect(iam[0].x).toBe(report[0].x);
  expect(report[0].y).toBeLessThan(iam[0].y);
  expectSideThenDrop(iam);
  expectSideThenDrop(report);
  expect(report.at(-1)?.x).toBeGreaterThan(iam.at(-1)?.x ?? 0);
});

test("Auto Neat leaves only the unavoidable crossing for a same-row link that spans other services", () => {
  const graph = systemGraph(nineCards, [...nineLinks, [5, 7]]);
  const rendered = renderRoutes(graph);
  const spanning = "Auth->Report";
  // Card hits and label problems stay forbidden for every connector, including the spanning one.
  expect(cardProblems(graph, rendered)).toEqual([]);
  expect(pairProblems(graph, rendered).filter((problem) => !problem.endsWith(" touch"))).toEqual([]);
  // Auth -> Report must cross the IAM drop to the gateway or the IAM database link; exactly one of them, and nothing else.
  const touching = pairProblems(graph, rendered).filter((problem) => problem.endsWith(" touch"));
  expect(touching).toHaveLength(1);
  const allowed = ["IAM->Gateway", "IAM->IAM DB"].map((other) => [other, spanning] as [string, string]);
  const tolerated = touching.filter((problem) =>
    allowed.some(([x, y]) => problem === `${x} x ${y} touch` || problem === `${y} x ${x} touch`),
  );
  expect(tolerated).toEqual(touching);
  const routes = rendered.routes;
  const route = routeBetween(graph, routes, "Auth", "Report");
  expect(route.points.length).toBeGreaterThan(4);
  // The route's own clearance is explicit: no other card is within the 8px margin and no label sits on a card.
  const own = rendered.routes.find((item) => describe(graph, item) === spanning);
  expect(own).toBeDefined();
  expect(cardProblems(graph, rendered).filter((problem) => problem.startsWith(spanning))).toEqual([]);
});

// A route forced to cross another connector still has to keep its own label readable: the anchor steps along the
// route until the chip clears the connector it must cross.
test("Auto Neat keeps the spanning link's label clear of the IAM drop it must cross", () => {
  const graph = systemGraph(nineCards, [...nineLinks, [5, 7]]);
  const rendered = renderRoutes(graph);
  const problems = pairProblems(graph, rendered);
  expect(problems.filter((problem) => problem.includes("label"))).toEqual([]);
  const spanning = routeBetween(graph, rendered.routes, "Auth", "Report");
  const iam = routeBetween(graph, rendered.routes, "IAM", "Gateway");
  const drop = iam.segments.find((segment) => segment.from.x === segment.to.x);
  if (!drop) throw new Error("IAM -> Gateway has no vertical drop");
  // The bare arc-length midpoint would sit exactly under the drop; the resolved anchor must not.
  expect(rectsOverlap(labelRect(spanning.label, spanning.labelSize), segRect(drop))).toBe(false);
});

test("Auto Neat keeps services fanning out to both sides of the gateway clear", () => {
  const cards = [
    typed("Gateway", 1, "gateway"),
    ...["A", "B", "C", "D", "E", "F", "G"].map((name, index) => typed(`Svc ${name}`, 2 + index, "service")),
    typed("DB D", 9, "database"),
    typed("DB F", 10, "database"),
  ];
  const links: Array<[number, number]> = [2, 3, 4, 5, 6, 7, 8]
    .map((n) => [1, n] as [number, number])
    .concat([
      [5, 9],
      [7, 10],
    ]);
  const graph = systemGraph(cards, links);
  const { routes } = expectClearRoutes(graph);
  const run = (name: string) => fromGateway(graph, routes, name)[0];
  expect(new Set(["A", "B", "C"].map((name) => run(`Svc ${name}`).y)).size).toBe(3);
  expect(new Set(["E", "F", "G"].map((name) => run(`Svc ${name}`).y)).size).toBe(3);
  // The middle service sits straight below the gateway; the farther a service, the higher its run.
  expect(straight(fromGateway(graph, routes, "Svc D"))).toBe(true);
  expect(run("Svc A").y).toBeLessThan(run("Svc B").y);
  expect(run("Svc B").y).toBeLessThan(run("Svc C").y);
  expect(run("Svc G").y).toBeLessThan(run("Svc F").y);
});

test("Auto Neat gives the same bends when applied again to the user's canvas and the nine-card canvas", () => {
  for (const graph of [systemGraph(userCards, userLinks), systemGraph(nineCards, nineLinks)]) {
    const { first, again } = applyAgain(graph);
    expect(again.connections.map(({ connectionId, bend }) => [connectionId, bend])).toEqual(
      first.connections.map(({ connectionId, bend }) => [connectionId, bend]),
    );
    expect(again).toEqual(first);
  }
});

// Checks the gateway's attachment points: distinct on each side, and nested so the farther a service, the higher its run.
function expectNestedGatewaySides(graph: CanvasGraph) {
  const rendered = renderRoutes(graph);
  const gatewayId = graph.entities.find((e) => (e as { name?: string }).name === "Gateway")?.id ?? "";
  const gateway = rendered.absolute(gatewayId);
  const bySide = new Map<string, Array<{ point: Pt; distance: number; dx: number }>>();
  for (const route of rendered.routes) {
    const atGateway = route.connection.sourceEntityId === gatewayId;
    const otherId = atGateway ? route.connection.targetEntityId : route.connection.sourceEntityId;
    const other = rendered.absolute(otherId);
    const side = atGateway ? route.port.sourceSide : route.port.targetSide;
    const dx = other.x + other.width / 2 - (gateway.x + gateway.width / 2);
    bySide.set(side, [
      ...(bySide.get(side) ?? []),
      { point: atGateway ? route.port.source : route.port.target, distance: Math.abs(dx), dx },
    ]);
  }
  for (const [side, attachments] of bySide) {
    const axis = side === "left" || side === "right" ? "y" : "x";
    expect(new Set(attachments.map(({ point }) => point[axis])).size).toBe(attachments.length);
    const ordered = [...attachments].sort((a, b) => (axis === "y" ? b.distance - a.distance : a.dx - b.dx));
    for (let index = 1; index < ordered.length; index++)
      expect(ordered[index].point[axis]).toBeGreaterThan(ordered[index - 1].point[axis]);
  }
  return { rendered, bySide };
}

test("Auto Neat keeps eight services around one gateway clear with distinct nested attachment points", () => {
  const cards = [
    typed("Gateway", 1, "gateway"),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => typed(`Svc ${n}`, 1 + n, "service")),
  ];
  const graph = systemGraph(
    cards,
    [2, 3, 4, 5, 6, 7, 8, 9].map((n) => [1, n] as [number, number]),
  );
  expectClearRoutes(graph);
  const { bySide } = expectNestedGatewaySides(graph);
  expect([...bySide.values()].reduce((sum, items) => sum + items.length, 0)).toBe(8);
});

test("Auto Neat handles four services on each side of the gateway plus those straight below", () => {
  const cards = [
    typed("Gateway", 1, "gateway"),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => typed(`Svc ${n}`, 1 + n, "service")),
  ];
  const graph = systemGraph(
    cards,
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => [1, n] as [number, number]),
  );
  expectClearRoutes(graph);
  const { bySide } = expectNestedGatewaySides(graph);
  expect(bySide.get("left")?.length).toBeGreaterThanOrEqual(4);
  expect(bySide.get("right")?.length).toBeGreaterThanOrEqual(4);
});

test("Auto Neat separates connections in both directions and duplicates between one pair", () => {
  const cards = [typed("Svc A", 1, "service"), typed("Svc B", 2, "service")];
  for (const links of [
    [
      [1, 2],
      [2, 1],
    ],
    [
      [1, 2],
      [1, 2],
    ],
    [
      [1, 2],
      [2, 1],
      [1, 2],
    ],
  ] as Array<Array<[number, number]>>) {
    const graph = systemGraph(cards, links);
    const { routes } = expectClearRoutes(graph);
    expect(routes).toHaveLength(links.length);
    // Every attachment on a given card side is a distinct point.
    const seen = new Set<string>();
    for (const route of routes)
      for (const [entityId, point, side] of [
        [route.connection.sourceEntityId, route.port.source, route.port.sourceSide],
        [route.connection.targetEntityId, route.port.target, route.port.targetSide],
      ] as const) {
        const key = `${entityId}:${side}:${point.x}:${point.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    expect(seen.size).toBe(links.length * 2);
  }
});

test("Auto Neat routes a same-row link over the top of a service between them when nothing is in the gutter", () => {
  const graph = systemGraph(
    [typed("Svc A", 1, "service"), typed("Svc B", 2, "service"), typed("Svc C", 3, "service")],
    [[1, 3]],
  );
  const { routes } = expectClearRoutes(graph);
  const rendered = renderRoutes(graph);
  const [route] = routes;
  // Collapse the polyline into its directions: the middle run goes up, across, then down.
  const directions: string[] = [];
  route.segments.forEach(({ from, to }) => {
    const direction = from.x === to.x ? (to.y < from.y ? "up" : "down") : to.x > from.x ? "right" : "left";
    if (directions.at(-1) !== direction) directions.push(direction);
  });
  expect(directions.join(",")).toContain("up,right,down");
  const across = route.segments.find(({ from, to }) => from.y === to.y && Math.abs(to.x - from.x) > 100);
  if (!across) throw new Error("Missing across run");
  for (const card of rendered.cards) expect(across.from.y).toBeLessThan(card.y);
});
