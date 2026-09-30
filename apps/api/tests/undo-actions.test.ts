import { beforeEach, describe, expect, it } from "bun:test";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Graph = {
  entities: Array<{ id: string; name: string; description: string | null; metadata: Record<string, unknown> }>;
  connections: Array<{
    id: string;
    type: string;
    label: string;
    description: string | null;
    metadata: Record<string, unknown>;
    bend: unknown;
  }>;
};
type UndoResult = { undone: boolean; action?: string };

async function setup() {
  const owner = await api.register("Undo Owner");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
  const service = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const database = await api.createNode(owner.session, canvasId, { type: "database", name: "Orders DB", x: 500 });
  const connectionId = await api.connect(owner.session, canvasId, service, database);
  const graph = async () => (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
  const undo = async () => (await api.json<UndoResult>("POST", `/api/canvases/${canvasId}/undo`, owner.session)).body;
  return { owner, canvasId, service, database, connectionId, graph, undo };
}

describe("undo restores edited items", () => {
  it("reverts a node's name, description, and metadata", async () => {
    const { owner, service, graph, undo } = await setup();
    await api.request("PATCH", `/api/entities/${service}`, owner.session, {
      name: "Order Service",
      description: "Accepts orders",
      metadata: { language: "Go", status: "planned" },
    });
    expect((await graph()).entities.find((entity) => entity.id === service)?.name).toBe("Order Service");

    expect(await undo()).toMatchObject({ undone: true, action: "entity.updated" });
    const restored = (await graph()).entities.find((entity) => entity.id === service);
    expect(restored).toMatchObject({ name: "Orders API", description: null, metadata: {} });
  });

  it("reverts a connection's protocol, label, description, and metadata", async () => {
    const { owner, connectionId, graph, undo } = await setup();
    await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, {
      type: "grpc",
      label: "Loads orders",
      description: "Nightly",
      metadata: { contract: "orders.v1" },
    });
    expect(await undo()).toMatchObject({ undone: true, action: "connection.updated" });
    expect((await graph()).connections[0]).toMatchObject({
      type: "rest",
      label: "",
      description: null,
      metadata: {},
    });
  });

  it("reverts a connector route to its previous path", async () => {
    const { owner, canvasId, connectionId, graph, undo } = await setup();
    const url = `/api/canvases/${canvasId}/connections/${connectionId}/bend`;
    await api.request("PUT", url, owner.session, { bend: { x: 200, y: 40 } });
    await api.request("PUT", url, owner.session, { bend: [{ x: 300, y: 90 }] });

    expect(await undo()).toMatchObject({ undone: true, action: "connection.updated" });
    expect((await graph()).connections[0].bend).toEqual({ x: 200, y: 40 });
    expect(await undo()).toMatchObject({ undone: true, action: "connection.updated" });
    expect((await graph()).connections[0].bend).toBeNull();
  });
});

describe("undo reverses connector creation and deletion", () => {
  it("removes a connection the actor created", async () => {
    const { graph, undo } = await setup();
    expect((await graph()).connections).toHaveLength(1);
    expect(await undo()).toMatchObject({ undone: true, action: "connection.created" });
    expect((await graph()).connections).toEqual([]);
  });

  it("restores a deleted connection with its route", async () => {
    const { owner, canvasId, connectionId, graph, undo } = await setup();
    await api.request("PUT", `/api/canvases/${canvasId}/connections/${connectionId}/bend`, owner.session, {
      bend: { x: 250, y: 60 },
    });
    expect(
      (await api.request("DELETE", `/api/canvases/${canvasId}/connections/${connectionId}`, owner.session)).status,
    ).toBe(200);
    expect((await graph()).connections).toEqual([]);

    expect(await undo()).toMatchObject({ undone: true, action: "connection.deleted" });
    expect((await graph()).connections).toEqual([
      expect.objectContaining({ id: connectionId, bend: { x: 250, y: 60 } }),
    ]);
  });
});
