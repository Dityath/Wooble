import { beforeEach, describe, expect, it } from "bun:test";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Connection = {
  id: string;
  type: string;
  label: string;
  description: string | null;
  metadata: Record<string, unknown>;
  sourceName?: string;
  targetName?: string;
};

async function canvasWithConnection() {
  const owner = await api.register("Connection Owner");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
  const source = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const target = await api.createNode(owner.session, canvasId, { type: "database", name: "Orders DB", x: 400 });
  const connectionId = await api.connect(owner.session, canvasId, source, target);
  return { owner, canvasId, source, target, connectionId };
}

describe("connection details", () => {
  it("returns a connection with its endpoint names", async () => {
    const { owner, connectionId } = await canvasWithConnection();
    const { status, body } = await api.json<Connection>("GET", `/api/connections/${connectionId}`, owner.session);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: connectionId, type: "rest", sourceName: "Orders API", targetName: "Orders DB" });
  });

  it("rejects malformed IDs and reports missing connections", async () => {
    const { owner } = await canvasWithConnection();
    expect((await api.request("GET", "/api/connections/not-a-uuid", owner.session)).status).toBe(400);
    const missing = await api.json<{ message: string }>(
      "GET",
      `/api/connections/${crypto.randomUUID()}`,
      owner.session,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Connection not found");
    expect((await api.request("PATCH", "/api/connections/not-a-uuid", owner.session, { label: "x" })).status).toBe(400);
    expect(
      (await api.request("PATCH", `/api/connections/${crypto.randomUUID()}`, owner.session, { label: "Lost" })).status,
    ).toBe(404);
  });
});

describe("connection updates", () => {
  it("updates fields, merges metadata, and records the change on the canvas", async () => {
    const { owner, canvasId, connectionId } = await canvasWithConnection();
    const first = await api.json<Connection>("PATCH", `/api/connections/${connectionId}`, owner.session, {
      type: "grpc",
      label: "Loads orders",
      description: "Nightly sync",
      metadata: { contract: "orders.v1", direction: "two-way", documentation: "Notes" },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      type: "grpc",
      label: "Loads orders",
      description: "Nightly sync",
      metadata: { contract: "orders.v1", direction: "two-way", documentation: "Notes" },
    });

    const second = await api.json<Connection>("PATCH", `/api/connections/${connectionId}`, owner.session, {
      metadata: { contract: null, documentation: "" },
    });
    expect(second.body).toMatchObject({ type: "grpc", label: "Loads orders", description: "Nightly sync" });
    expect(second.body.metadata).toEqual({ direction: "two-way" });

    const cleared = await api.json<Connection>("PATCH", `/api/connections/${connectionId}`, owner.session, {
      description: null,
    });
    expect(cleared.body.description).toBeNull();

    const activity = await api.json<{ events: Array<{ action: string; targetName: string; metadata: unknown }> }>(
      "GET",
      `/api/canvases/${canvasId}/activity`,
      owner.session,
    );
    const updates = activity.body.events.filter((event) => event.action === "connection.updated");
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)).toMatchObject({
      targetName: "Loads orders",
      metadata: { fields: ["type", "label", "description", "metadata"], previous: { type: "rest", label: "" } },
    });
  });

  it("validates the update body", async () => {
    const { owner, connectionId } = await canvasWithConnection();
    const empty = await api.json<{ message: string }>("PATCH", `/api/connections/${connectionId}`, owner.session, {});
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe("No changes provided");
    expect(
      (await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, { type: "carrier-pigeon" }))
        .status,
    ).toBe(400);
  });
});

describe("connection access", () => {
  it("lets canvas editors change a connection and viewers only read it", async () => {
    const { owner, canvasId, connectionId } = await canvasWithConnection();
    const editor = await api.register("Connection Editor");
    const viewer = await api.register("Connection Viewer");
    const outsider = await api.register("Connection Outsider");
    for (const [person, role] of [
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const) {
      const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
      expect((await api.request("POST", `/api/invitations/${token}/accept`, person.session)).status).toBe(200);
    }
    const url = `/api/connections/${connectionId}`;

    expect((await api.request("GET", url, viewer.session)).status).toBe(200);
    expect((await api.request("PATCH", url, viewer.session, { label: "Viewer edit" })).status).toBe(403);
    expect((await api.request("PATCH", url, editor.session, { label: "Editor edit" })).status).toBe(200);
    expect((await api.request("GET", url, outsider.session)).status).toBe(403);
    expect((await api.request("GET", url)).status).toBe(401);
  });

  it("lets anyone read connections on a link-shared canvas, but only through that canvas", async () => {
    const { owner, canvasId, connectionId } = await canvasWithConnection();
    const visitor = await api.register("Link Visitor");
    const url = `/api/connections/${connectionId}`;
    expect((await api.request("GET", url, visitor.session)).status).toBe(403);

    await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "link" });
    expect((await api.request("GET", url, visitor.session)).status).toBe(200);
    expect((await api.request("PATCH", url, visitor.session, { label: "Drive-by" })).status).toBe(403);
  });
});
