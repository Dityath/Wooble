import { expect, test } from "bun:test";
import type { CanvasGraph } from "../src/lib/api";
import { buildAutoNeatLayout, candidateCorners } from "../src/features/canvas/auto-neat";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const placement = (number: number, parent: number | null, x: number, y: number, width = 200, height = 120) => ({
  canvasId: id(9000),
  entityId: id(number),
  parentEntityId: parent ? id(parent) : null,
  x,
  y,
  width,
  height,
});

test("a same-row link with no room for generated routes still yields a candidate", () => {
  const a = { x: 0, y: 0, width: 200, height: 120 };
  const b = { x: 210, y: 20, width: 200, height: 120 };
  const candidates = candidateCorners(2, { x: 200, y: 60 }, { x: 210, y: 80 }, "right", a, b);
  expect(candidates.length).toBeGreaterThan(0);
});

test("every connection is returned; self-links and unplaced links keep their stored bend", () => {
  const stored = [
    { x: 5, y: 6 },
    { x: 7, y: 8 },
    { x: 9, y: 10 },
  ];
  const graph = {
    canvas: { id: id(9000), updatedAt: "2026-09-24T00:00:00.000Z" },
    entities: [1, 2, 3].map((number) => ({ id: id(number), type: "service", name: `S${number}` })),
    placements: [placement(1, null, 0, 0), placement(2, null, 400, 0)],
    connections: [
      { id: id(10), sourceEntityId: id(1), targetEntityId: id(2), bend: null },
      { id: id(11), sourceEntityId: id(1), targetEntityId: id(1), bend: { x: 40, y: 50 } },
      { id: id(12), sourceEntityId: id(1), targetEntityId: id(3), bend: stored },
      { id: id(13), sourceEntityId: id(3), targetEntityId: id(2), bend: null },
    ],
  } as unknown as CanvasGraph;
  const result = buildAutoNeatLayout(graph);
  const bend = (n: number) => result.connections.find((item) => item.connectionId === id(n))?.bend;
  expect(result.connections).toHaveLength(4);
  expect(bend(10)).toBeDefined();
  expect(bend(11)).toEqual({ x: 40, y: 50 });
  expect(bend(12)).toEqual(stored);
  expect(bend(13)).toEqual({ x: 0, y: 0 });
});

test("Auto Neat on ~100 nodes and ~150 connections is fast and routes every connection", () => {
  const systems = 5;
  const perSystem = 19;
  const entities: Array<{ id: string; type: string; name: string }> = [];
  const placements: ReturnType<typeof placement>[] = [];
  const types = ["frontend", "gateway", "service", "service", "database"];
  let next = 1;
  const nodeIds: number[] = [];
  for (let s = 0; s < systems; s++) {
    const systemId = next++;
    entities.push({ id: id(systemId), type: "system", name: `System ${s}` });
    placements.push(placement(systemId, null, 0, 0, 300, 300));
    for (let n = 0; n < perSystem; n++) {
      const nodeId = next++;
      entities.push({ id: id(nodeId), type: types[n % types.length] ?? "service", name: `Node ${s}-${n}` });
      placements.push(placement(nodeId, systemId, (n % 4) * 10, (n % 5) * 10));
      nodeIds.push(nodeId);
    }
  }
  const connections: CanvasGraph["connections"] = [];
  for (let c = 0; c < 150; c++) {
    const source = nodeIds[(c * 7) % nodeIds.length] ?? 0;
    const target = nodeIds[(c * 13 + 5) % nodeIds.length] ?? 0;
    connections.push({
      id: id(5000 + c),
      sourceEntityId: id(source),
      targetEntityId: id(target === source ? (nodeIds[(c + 1) % nodeIds.length] ?? 0) : target),
      bend: null,
    } as CanvasGraph["connections"][number]);
  }
  const graph = {
    canvas: { id: id(9000), updatedAt: "2026-09-24T00:00:00.000Z" },
    entities,
    placements,
    connections,
  } as unknown as CanvasGraph;
  const start = performance.now();
  const result = buildAutoNeatLayout(graph);
  const elapsed = performance.now() - start;
  console.log(`auto-neat 100 nodes / 150 connections: ${elapsed.toFixed(0)} ms`);
  expect(elapsed).toBeLessThan(1500);
  expect(result.connections).toHaveLength(connections.length);
  for (const item of result.connections) expect(item.bend).toBeDefined();
});
