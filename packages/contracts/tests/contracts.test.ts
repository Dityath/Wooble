import { describe, expect, it } from "bun:test";
import {
  autoNeatCanvasSchema,
  canvasActivityQuerySchema,
  createCanvasConnectionSchema,
  createCanvasEntitySchema,
  createCanvasSchema,
  updateCanvasConnectionBendSchema,
  updateConnectionSchema,
  updateEntitySchema,
  updatePlacementsSchema,
} from "../src/index";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

function issueMessages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }) {
  return result.error?.issues.map((issue) => issue.message) ?? [];
}

describe("canvas contracts", () => {
  it("trims canvas names and defaults the description", () => {
    expect(createCanvasSchema.parse({ workspaceId: first, name: "  Payments  " })).toEqual({
      workspaceId: first,
      name: "Payments",
      description: "",
    });
    expect(createCanvasSchema.safeParse({ workspaceId: first, name: "   " }).success).toBe(false);
    expect(createCanvasSchema.safeParse({ workspaceId: "not-a-uuid", name: "Payments" }).success).toBe(false);
  });

  it("accepts only known entity types on integer canvas coordinates", () => {
    expect(createCanvasEntitySchema.parse({ type: "service", x: 10, y: -20, parentEntityId: null }).name).toBe("");
    expect(createCanvasEntitySchema.safeParse({ type: "robot", x: 0, y: 0, parentEntityId: null }).success).toBe(false);
    expect(createCanvasEntitySchema.safeParse({ type: "service", x: 0.5, y: 0, parentEntityId: null }).success).toBe(
      false,
    );
  });

  it("rejects a connection from a node to itself and defaults to REST", () => {
    expect(createCanvasConnectionSchema.parse({ sourceEntityId: first, targetEntityId: second }).type).toBe("rest");
    expect(
      issueMessages(createCanvasConnectionSchema.safeParse({ sourceEntityId: first, targetEntityId: first })),
    ).toEqual(["Choose two different nodes"]);
  });

  it("accepts a single bend or up to twelve waypoints inside canvas bounds", () => {
    expect(updateCanvasConnectionBendSchema.parse({ bend: null }).bend).toBeNull();
    expect(updateCanvasConnectionBendSchema.parse({ bend: { x: 5, y: 6 } }).bend).toEqual({ x: 5, y: 6 });
    const waypoints = Array.from({ length: 12 }, (_, index) => ({ x: index, y: index }));
    expect(updateCanvasConnectionBendSchema.safeParse({ bend: waypoints }).success).toBe(true);
    expect(updateCanvasConnectionBendSchema.safeParse({ bend: [...waypoints, { x: 0, y: 0 }] }).success).toBe(false);
    expect(updateCanvasConnectionBendSchema.safeParse({ bend: { x: 1000001, y: 0 } }).success).toBe(false);
  });

  it("reports every duplicate in an auto-neat layout", () => {
    const placement = { entityId: first, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 };
    const route = { connectionId: second, bend: { x: 1, y: 1 } };
    const valid = {
      expectedUpdatedAt: "2026-09-30T08:00:00.000Z",
      placements: [placement],
      connections: [route],
    };
    expect(autoNeatCanvasSchema.safeParse(valid).success).toBe(true);
    expect(
      issueMessages(
        autoNeatCanvasSchema.safeParse({ ...valid, placements: [placement, placement], connections: [route, route] }),
      ),
    ).toEqual(["Duplicate node placements", "Duplicate connector routes"]);
    expect(autoNeatCanvasSchema.safeParse({ ...valid, expectedUpdatedAt: "yesterday" }).success).toBe(false);
    expect(autoNeatCanvasSchema.safeParse({ ...valid, placements: [{ ...placement, width: 0 }] }).success).toBe(false);
  });

  it("points a duplicate placement error at the repeated entity", () => {
    const placement = { entityId: first, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 };
    const result = updatePlacementsSchema.safeParse({
      placements: [placement, { ...placement, entityId: second }, { ...placement, x: 40 }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["placements", 2, "entityId"],
        message: "Each entity may only have one placement",
      }),
    ]);
    expect(updatePlacementsSchema.safeParse({ placements: [] }).success).toBe(true);
  });

  it("coerces the activity page size from the query string within limits", () => {
    expect(canvasActivityQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(canvasActivityQuerySchema.parse({ limit: "200" })).toEqual({ limit: 200 });
    expect(canvasActivityQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(canvasActivityQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });
});

describe("entity and connection update contracts", () => {
  it("require at least one change", () => {
    expect(issueMessages(updateEntitySchema.safeParse({}))).toEqual(["No changes provided"]);
    expect(issueMessages(updateConnectionSchema.safeParse({}))).toEqual(["No changes provided"]);
  });

  it("trim entity fields, allow clearing metadata, and bound list sizes", () => {
    expect(updateEntitySchema.parse({ name: "  Billing API  ", metadata: { language: null } })).toEqual({
      name: "Billing API",
      metadata: { language: null },
    });
    expect(updateEntitySchema.safeParse({ name: " " }).success).toBe(false);
    expect(
      updateEntitySchema.safeParse({ metadata: { interfaces: Array.from({ length: 21 }, (_, i) => `api-${i}`) } })
        .success,
    ).toBe(false);
    expect(updateEntitySchema.safeParse({ metadata: { status: "retired" } }).success).toBe(false);
  });

  it("accept connection direction and contract edits but reject unknown protocols", () => {
    expect(updateConnectionSchema.parse({ metadata: { direction: "two-way", contract: "  orders.v1  " } })).toEqual({
      metadata: { direction: "two-way", contract: "orders.v1" },
    });
    expect(updateConnectionSchema.safeParse({ type: "carrier-pigeon" }).success).toBe(false);
    expect(updateConnectionSchema.safeParse({ label: "x".repeat(101) }).success).toBe(false);
  });
});
