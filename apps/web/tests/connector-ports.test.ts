import { expect, test } from "bun:test";
import { connectorPorts } from "../src/features/canvas/connector-ports";

const card = (x: number, y: number) => ({ x, y, width: 220, height: 120 });
const link = (id: string, sourceEntityId: string, targetEntityId: string) => ({ id, sourceEntityId, targetEntityId });

test("a single attachment stays at the middle of its side", () => {
  const boxes = new Map([
    ["a", card(0, 0)],
    ["b", card(0, 300)],
  ]);
  const port = connectorPorts(boxes, [link("c1", "a", "b")]).get("c1");
  expect(port?.source).toEqual({ x: 110, y: 120 });
  expect(port?.target).toEqual({ x: 110, y: 300 });
  expect(port?.sourceOffset).toEqual({ x: 0, y: 0 });
  expect(port?.targetOffset).toEqual({ x: 0, y: 0 });
});

test("connectors on one side spread evenly, with farther targets higher", () => {
  const boxes = new Map([
    ["g", card(0, 0)],
    ["a", card(340, 300)],
    ["b", card(680, 300)],
    ["c", card(1020, 300)],
  ]);
  const ports = connectorPorts(boxes, [link("1", "g", "a"), link("2", "g", "b"), link("3", "g", "c")]);
  const ys = ["3", "2", "1"].map((id) => ports.get(id)?.source.y);
  expect(ys).toEqual([30, 60, 90]);
  for (const id of ["1", "2", "3"]) {
    expect(ports.get(id)?.sourceSide).toBe("right");
    expect(ports.get(id)?.targetSide).toBe("top");
    expect(ports.get(id)?.source.x).toBe(220);
    expect(ports.get(id)?.sourceOffset.x).toBe(0);
  }
  expect(ports.get("3")?.sourceOffset.y).toBe(-30);
});

test("same-row connectors take the top of a side before down-going ones", () => {
  const boxes = new Map([
    ["g", card(0, 0)],
    ["row", card(400, 0)],
    ["low", card(800, 300)],
  ]);
  const ports = connectorPorts(boxes, [link("1", "g", "low"), link("2", "g", "row")]);
  expect(ports.get("2")?.source.y).toBeLessThan(ports.get("1")?.source.y ?? 0);
});

test("drops into a top side are ordered so that lower runs sit further out", () => {
  const boxes = new Map([
    ["n", card(1000, 400)],
    ["farLeft", card(0, 0)],
    ["nearLeft", card(400, 0)],
    ["above", card(1000, 0)],
    ["nearRight", card(1600, 0)],
    ["farRight", card(2000, 0)],
  ]);
  const ids = ["farLeft", "nearLeft", "above", "nearRight", "farRight"];
  const ports = connectorPorts(
    boxes,
    ids.map((id) => link(id, id, "n")),
  );
  const xs = ids.map((id) => ports.get(id)?.target.x ?? 0);
  // Order along the top: nearLeft, farLeft, above, farRight, nearRight (nearer = lower run = further out).
  const order = [...ids].sort((a, b) => (ports.get(a)?.target.x ?? 0) - (ports.get(b)?.target.x ?? 0));
  expect(order).toEqual(["nearLeft", "farLeft", "above", "farRight", "nearRight"]);
  expect(new Set(xs).size).toBe(5);
  expect(ports.get("above")?.targetSide).toBe("top");
});

test("ports are deterministic and independent of connection order", () => {
  const boxes = new Map([
    ["g", card(0, 0)],
    ["a", card(340, 300)],
    ["b", card(340, 600)],
  ]);
  const links = [link("x", "g", "a"), link("y", "a", "g"), link("z", "g", "b")];
  const forward = connectorPorts(boxes, links);
  const backward = connectorPorts(boxes, [...links].reverse());
  for (const { id } of links) expect(backward.get(id)).toEqual(forward.get(id));
});

test("the user's gateway layout fans Report and IAM out of Gateway's right side", () => {
  const boxes = new Map([
    ["frontend", card(2352, 112)],
    ["gateway", card(2352, 342)],
    ["auth", card(2352, 572)],
    ["iam", card(2692, 572)],
    ["report", card(3032, 572)],
  ]);
  const ports = connectorPorts(boxes, [
    link("auth", "auth", "gateway"),
    link("iam", "iam", "gateway"),
    link("report", "report", "gateway"),
    link("frontend", "frontend", "gateway"),
  ]);
  const auth = ports.get("auth");
  expect(auth?.sourceSide).toBe("top");
  expect(auth?.targetSide).toBe("bottom");
  expect(auth?.source.x).toBe(auth?.target.x);
  const iam = ports.get("iam");
  const report = ports.get("report");
  for (const port of [iam, report]) {
    expect(port?.sourceSide).toBe("top");
    expect(port?.targetSide).toBe("right");
    expect(port?.target.x).toBe(2572);
  }
  // Each service leaves its own top mid-point.
  expect(iam?.source).toEqual({ x: 2802, y: 572 });
  expect(report?.source).toEqual({ x: 3142, y: 572 });
  expect(report?.target.y).toBeLessThan(iam?.target.y ?? 0);
  expect(iam?.target.y).toBeGreaterThan(342);
  expect(report?.target.y).toBeGreaterThan(342);
  expect(iam?.target.y).toBeLessThan(462);
  const frontend = ports.get("frontend");
  expect(frontend?.sourceSide).toBe("bottom");
  expect(frontend?.targetSide).toBe("top");
});

test("port positions are whole pixels and renderer endpoints reproduce them", async () => {
  const { applyPortOffset } = await import("../src/features/canvas/connector-route");
  const boxes = new Map([
    ["g", { x: 3, y: 0, width: 221, height: 121 }],
    ["a", { x: 340, y: 300, width: 220, height: 120 }],
    ["b", { x: 680, y: 301, width: 220, height: 120 }],
    ["c", { x: 1020, y: 300, width: 220, height: 120 }],
  ]);
  const ports = connectorPorts(boxes, [link("1", "g", "a"), link("2", "g", "b"), link("3", "g", "c")]);
  for (const [id, port] of ports) {
    const connection = [
      ["1", "a"],
      ["2", "b"],
      ["3", "c"],
    ].find(([key]) => key === id);
    for (const point of [port.source, port.target]) {
      expect(Number.isInteger(point.x)).toBe(true);
      expect(Number.isInteger(point.y)).toBe(true);
    }
    const handle = (box: { x: number; y: number; width: number; height: number }, side: string) =>
      side === "left" || side === "right"
        ? { x: side === "left" ? box.x : box.x + box.width, y: box.y + box.height / 2 }
        : { x: box.x + box.width / 2, y: side === "top" ? box.y : box.y + box.height };
    const source = boxes.get("g");
    const target = boxes.get(connection?.[1] ?? "");
    if (!source || !target) throw new Error("missing box");
    expect(applyPortOffset(handle(source, port.sourceSide), port.sourceOffset)).toEqual(port.source);
    expect(applyPortOffset(handle(target, port.targetSide), port.targetOffset)).toEqual(port.target);
  }
});

test("self-links get a centred port and do not shift other connectors", () => {
  const boxes = new Map([
    ["a", card(0, 0)],
    ["b", card(0, 300)],
  ]);
  const ports = connectorPorts(boxes, [link("s", "a", "a"), link("c1", "a", "b")]);
  expect(ports.get("s")).toBeDefined();
  expect(ports.get("c1")?.sourceOffset).toEqual({ x: 0, y: 0 });
});
