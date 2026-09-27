import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { canvasEvents, canvasNodes, db, entities } from "@wooble/db";

const app = createApp();

const email = `undo-${crypto.randomUUID().slice(0, 8)}@example.test`;
const password = "WoobleTestPassword-2026";

type ApiResponse = Response & { json(): Promise<unknown> };

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  headers: Record<string, string> = {},
  payload?: unknown,
): Promise<ApiResponse> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: payload === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }) as Request,
  ) as Promise<ApiResponse>;
}

let cookie = "";

interface Graph {
  canvas: { id: string; name: string; updatedAt: string };
  entities: Array<{ id: string; type: string; name: string }>;
  placements: Array<{ entityId: string; x: number; y: number; parentEntityId: string | null }>;
  connections: Array<{ id: string; sourceEntityId: string; targetEntityId: string; type: string; bend: unknown }>;
}

async function graph(canvasId: string): Promise<Graph> {
  const response = await request("GET", `/api/canvases/${canvasId}/graph`, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as Graph;
}

async function undo(
  canvasId: string,
): Promise<{ undone: boolean; action?: string; skipped?: Array<{ action: string; targetName: string | null }> }> {
  const response = await request("POST", `/api/canvases/${canvasId}/undo`, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    undone: boolean;
    action?: string;
    skipped?: Array<{ action: string; targetName: string | null }>;
  };
}

interface UndoConflictBody {
  error?: string;
  message?: string;
  skipped?: Array<{ action: string; targetName: string | null; reason: "conflict" | "no-op" }>;
}

async function postUndo(
  canvasId: string,
  actorCookie: string,
): Promise<{ status: number; body: Record<string, unknown> & UndoConflictBody }> {
  const response = await request("POST", `/api/canvases/${canvasId}/undo`, { cookie: actorCookie });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & UndoConflictBody };
}

async function undoByCookie(
  canvasId: string,
  actorCookie: string,
): Promise<{ undone: boolean; action?: string; skipped?: Array<{ action: string; targetName: string | null }> }> {
  const response = await request("POST", `/api/canvases/${canvasId}/undo`, { cookie: actorCookie });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    undone: boolean;
    action?: string;
    skipped?: Array<{ action: string; targetName: string | null }>;
  };
}

async function activity(canvasId: string): Promise<{
  events: Array<{ action: string; targetName: string | null; undoneAt: string | null; actorName: string }>;
}> {
  const response = await request("GET", `/api/canvases/${canvasId}/activity`, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    events: Array<{ action: string; targetName: string | null; undoneAt: string | null; actorName: string }>;
  };
}

beforeAll(async () => {
  resetLoginAttempts();
  const registered = await request(
    "POST",
    "/api/auth/register",
    {},
    { name: "Undo Tester", email, password, confirmPassword: password },
  );
  expect(registered.status).toBe(201);
  const login = await request("POST", "/api/auth/login", {}, { email, password });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
});

afterAll(async () => {
  if (app.server) await app.stop(true);
});

describe("Canvas undo reverts the actor's own recorded activity", () => {
  it("undoes a created node, a moved node, and a deleted node from the activity trail", async () => {
    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Undo WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Undo canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    // Node creation is undoable.
    const entityResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Billing", x: 10, y: 20, parentEntityId: null },
    );
    expect(entityResponse.status).toBe(201);
    expect((await graph(canvas.id)).entities).toHaveLength(1);

    const createUndo = await undo(canvas.id);
    expect(createUndo).toEqual({ undone: true, action: "entity.created", skipped: [] });
    expect((await graph(canvas.id)).entities).toHaveLength(0);

    // Undo with an empty trail reports that nothing was undone.
    expect(await undo(canvas.id)).toEqual({ undone: false });

    // Re-create, then move the node; the movement is undoable back to the saved position.
    const recreatedResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Billing", x: 10, y: 20, parentEntityId: null },
    );
    expect(recreatedResponse.status).toBe(201);
    const recreated = (await recreatedResponse.json()) as { id: string };
    const saved = await request(
      "PUT",
      `/api/canvases/${canvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: recreated.id, parentEntityId: null, x: 300, y: 400, width: 220, height: 120 }] },
    );
    expect(saved.status).toBe(200);
    expect((await graph(canvas.id)).placements[0]).toMatchObject({ x: 300, y: 400 });

    const moveUndo = await undo(canvas.id);
    expect(moveUndo).toEqual({ undone: true, action: "placement.updated", skipped: [] });
    expect((await graph(canvas.id)).placements[0]).toMatchObject({ x: 10, y: 20 });

    // Connector creation is undoable.
    const otherResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "database", name: "Main DB", x: 400, y: 20, parentEntityId: null },
    );
    const other = (await otherResponse.json()) as { id: string };
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie },
      { sourceEntityId: recreated.id, targetEntityId: other.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);
    expect((await graph(canvas.id)).connections).toHaveLength(1);

    expect(await undo(canvas.id)).toEqual({ undone: true, action: "connection.created", skipped: [] });
    expect((await graph(canvas.id)).connections).toHaveLength(0);

    // Deleting a node is undoable and restores the subtree from the snapshot.
    const deleteResponse = await request("DELETE", `/api/canvases/${canvas.id}/entities/${recreated.id}`, { cookie });
    expect(deleteResponse.status).toBe(200);
    expect((await graph(canvas.id)).entities).toHaveLength(1);

    const deleteUndo = await undo(canvas.id);
    expect(deleteUndo).toEqual({ undone: true, action: "entity.deleted", skipped: [] });
    const restored = await graph(canvas.id);
    expect(restored.entities.map((item) => item.id).sort()).toEqual([recreated.id, other.id].sort());
    expect(restored.placements.find((placement) => placement.entityId === recreated.id)).toMatchObject({
      x: 10,
      y: 20,
    });

    // The feed keeps the full history: every undo is recorded as its own activity entry
    // and the reverted events remain visible, flagged as undone.
    const feed = await activity(canvas.id);
    const actions = feed.events.map((event) => event.action).sort();
    expect(actions).toEqual(
      [
        "canvas.undo",
        "canvas.undo",
        "canvas.undo",
        "canvas.undo",
        "connection.created",
        "entity.created",
        "entity.created",
        "entity.created",
        "entity.deleted",
        "placement.updated",
      ].sort(),
    );
    const feedByAction = (action: string) => feed.events.filter((event) => event.action === action);
    expect(feedByAction("canvas.undo").every((event) => event.action === "canvas.undo")).toBe(true);
    expect(feedByAction("entity.deleted").every((event) => event.undoneAt !== null)).toBe(true);
    expect(feedByAction("connection.created").every((event) => event.undoneAt !== null)).toBe(true);
    expect(feedByAction("entity.created").filter((event) => event.undoneAt === null)).toHaveLength(2);
    const undoEntries = feedByAction("canvas.undo");
    expect(undoEntries.every((event) => event.actorName === "Undo Tester")).toBe(true);

    const recorded = await db
      .select({ action: canvasEvents.action })
      .from(canvasEvents)
      .where(eq(canvasEvents.canvasId, canvas.id));
    expect(recorded.filter((event) => event.action === "connection.created")).toHaveLength(1);
  });
});

describe("Canvas undo restores the pre-Auto-Neat layout", () => {
  it("undoes auto neat by restoring previous placements and connection bends", async () => {
    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Neat WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Neat canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    const firstResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Gateway", x: 10, y: 20, parentEntityId: null },
    );
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as { id: string };
    const secondResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "database", name: "Store", x: 400, y: 20, parentEntityId: null },
    );
    expect(secondResponse.status).toBe(201);
    const second = (await secondResponse.json()) as { id: string };
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie },
      { sourceEntityId: first.id, targetEntityId: second.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);

    const original = await graph(canvas.id);
    const connectionId = original.connections[0]?.id;
    expect(connectionId).toBeDefined();
    expect(original.connections[0]).toMatchObject({ bend: null });

    // Auto Neat rearranges every node and reroutes the connector.
    const neatResponse = await request(
      "PUT",
      `/api/canvases/${canvas.id}/auto-neat`,
      { cookie },
      {
        expectedUpdatedAt: original.canvas.updatedAt,
        placements: original.placements.map((placement) =>
          placement.entityId === first.id ? { ...placement, x: 100, y: 200 } : { ...placement, x: 500, y: 200 },
        ),
        connections: [{ connectionId: connectionId as string, bend: { x: 6, y: 7 } }],
      },
    );
    expect(neatResponse.status).toBe(200);
    const neatGraph = await graph(canvas.id);
    expect(neatGraph.placements.find((placement) => placement.entityId === first.id)).toMatchObject({
      x: 100,
      y: 200,
    });
    expect(neatGraph.connections[0]).toMatchObject({ bend: { x: 6, y: 7 } });

    // Undo must read the stored previous snapshot, not the flat metadata fields.
    expect(await undo(canvas.id)).toEqual({ undone: true, action: "canvas.auto_neat", skipped: [] });
    const restored = await graph(canvas.id);
    expect(restored.placements.find((placement) => placement.entityId === first.id)).toMatchObject({
      x: 10,
      y: 20,
    });
    expect(restored.placements.find((placement) => placement.entityId === second.id)).toMatchObject({
      x: 400,
      y: 20,
    });
    expect(restored.connections[0]).toMatchObject({ bend: null });
  });
});

describe("Canvas undo never overwrites collaborator changes", () => {
  it("skips conflicted events, undoes the older safe one, then refuses when all events conflict", async () => {
    const peerEmail = `undo-peer-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Peer Tester", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Shared WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Shared canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    const alphaResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Alpha", x: 10, y: 20, parentEntityId: null },
    );
    expect(alphaResponse.status).toBe(201);
    const alpha = (await alphaResponse.json()) as { id: string };
    const betaResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Beta", x: 30, y: 40, parentEntityId: null },
    );
    expect(betaResponse.status).toBe(201);
    const beta = (await betaResponse.json()) as { id: string };

    // The peer joins as a canvas editor.
    const invitationResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, {
      cookie: peerCookie,
    });
    expect(acceptResponse.status).toBe(200);

    // The owner moves Alpha; the peer then moves the same node.
    const ownerMove = await request(
      "PUT",
      `/api/canvases/${canvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: alpha.id, parentEntityId: null, x: 300, y: 400, width: 220, height: 120 }] },
    );
    expect(ownerMove.status).toBe(200);
    const peerMove = await request(
      "PUT",
      `/api/canvases/${canvas.id}/placements`,
      { cookie: peerCookie },
      { placements: [{ entityId: alpha.id, parentEntityId: null, x: 700, y: 800, width: 220, height: 120 }] },
    );
    expect(peerMove.status).toBe(200);

    // The owner's undo skips their move (superseded by the peer's) and falls
    // back to the older, untouched event: deleting the Beta node.
    const firstUndo = await postUndo(canvas.id, cookie);
    expect(firstUndo.status).toBe(200);
    expect(firstUndo.body).toEqual({
      undone: true,
      action: "entity.created",
      skipped: [{ action: "placement.updated", targetName: "Alpha", reason: "conflict" }],
    });
    let current = await graph(canvas.id);
    expect(current.entities.map((entity) => entity.id)).toEqual([alpha.id]);
    expect(current.entities.map((entity) => entity.id)).not.toContain(beta.id);
    expect(current.placements.find((placement) => placement.entityId === alpha.id)).toMatchObject({
      x: 700,
      y: 800,
    });

    // A second undo has nothing safe left: both remaining events touch Alpha,
    // which the peer edited, so the API refuses instead of restoring it.
    const secondUndo = await postUndo(canvas.id, cookie);
    expect(secondUndo.status).toBe(409);
    expect(secondUndo.body.error).toBe("undo_conflict");
    expect(secondUndo.body.skipped).toEqual([
      { action: "placement.updated", targetName: "Alpha", reason: "conflict" },
      { action: "entity.created", targetName: "Alpha", reason: "conflict" },
    ]);
    current = await graph(canvas.id);
    expect(current.entities.map((entity) => entity.id)).toEqual([alpha.id]);
    expect(current.placements.find((placement) => placement.entityId === alpha.id)).toMatchObject({
      x: 700,
      y: 800,
    });
  });
});

describe("Canvas undo keeps connectors collaborators attached", () => {
  it("refuses to undo a node creation once a collaborator connected it", async () => {
    const peerEmail = `undo-link-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Link Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Link WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Link canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    const hubResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Hub", x: 10, y: 20, parentEntityId: null },
    );
    expect(hubResponse.status).toBe(201);
    const hub = (await hubResponse.json()) as { id: string };
    const spokeResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "service", name: "Spoke", x: 400, y: 20, parentEntityId: null },
    );
    expect(spokeResponse.status).toBe(201);
    const spoke = (await spokeResponse.json()) as { id: string };

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The peer connects the two nodes the owner created.
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie: peerCookie },
      { sourceEntityId: hub.id, targetEntityId: spoke.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);

    // Undoing either node creation would cascade-delete the peer's connector,
    // so both candidates must be skipped and the API refuses.
    const undoAttempt = await postUndo(canvas.id, cookie);
    expect(undoAttempt.status).toBe(409);
    expect(undoAttempt.body.error).toBe("undo_conflict");
    expect(undoAttempt.body.skipped).toEqual([
      { action: "entity.created", targetName: "Spoke", reason: "conflict" },
      { action: "entity.created", targetName: "Hub", reason: "conflict" },
    ]);

    const current = await graph(canvas.id);
    expect(current.entities.map((entity) => entity.id).sort()).toEqual([hub.id, spoke.id].sort());
    expect(current.connections).toHaveLength(1);
    expect(current.connections[0]).toMatchObject({ sourceEntityId: hub.id, targetEntityId: spoke.id });
  });
});

describe("Canvas undo restores only the fields the actor changed", () => {
  it("leaves collaborator canvas edits alone and skips overlapping renames", async () => {
    const managerEmail = `undo-manager-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Manager Peer", email: managerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const managerLogin = await request("POST", "/api/auth/login", {}, { email: managerEmail, password });
    expect(managerLogin.status).toBe(200);
    const managerCookie = managerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Canvas WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Orig", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    // The peer joins the workspace as a manager so they may edit the canvas.
    const memberResponse = await request(
      "POST",
      `/api/workspaces/${workspace.id}/members`,
      { cookie },
      { email: managerEmail, role: "manager" },
    );
    expect(memberResponse.status).toBe(201);

    // The owner renames; the peer edits a different field afterwards.
    const ownerRename = await request("PATCH", `/api/canvases/${canvas.id}`, { cookie }, { name: "Renamed by A" });
    expect(ownerRename.status).toBe(200);
    const peerEdit = await request(
      "PATCH",
      `/api/canvases/${canvas.id}`,
      { cookie: managerCookie },
      { description: "Updated by B" },
    );
    expect(peerEdit.status).toBe(200);

    // Undoing the owner's rename must restore the name only, keeping the
    // peer's description change intact.
    const firstUndo = await postUndo(canvas.id, cookie);
    expect(firstUndo.status).toBe(200);
    expect(firstUndo.body).toEqual({ undone: true, action: "canvas.updated", skipped: [] });
    const afterFirst = await request("GET", `/api/canvases/${canvas.id}`, { cookie });
    expect(afterFirst.status).toBe(200);
    const current = (await afterFirst.json()) as { name: string; description: string };
    expect(current.name).toBe("Orig");
    expect(current.description).toBe("Updated by B");
  });

  it("refuses to undo a rename a collaborator superseded", async () => {
    const managerEmail = `undo-manager-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Manager Peer 2", email: managerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const managerLogin = await request("POST", "/api/auth/login", {}, { email: managerEmail, password });
    expect(managerLogin.status).toBe(200);
    const managerCookie = managerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Canvas WS 2", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Orig", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };
    const memberResponse = await request(
      "POST",
      `/api/workspaces/${workspace.id}/members`,
      { cookie },
      { email: managerEmail, role: "manager" },
    );
    expect(memberResponse.status).toBe(201);

    // Both managers rename the same field; the peer's rename lands last.
    const ownerRename = await request("PATCH", `/api/canvases/${canvas.id}`, { cookie }, { name: "Renamed by A" });
    expect(ownerRename.status).toBe(200);
    const peerRename = await request(
      "PATCH",
      `/api/canvases/${canvas.id}`,
      { cookie: managerCookie },
      { name: "Renamed by B" },
    );
    expect(peerRename.status).toBe(200);

    // Undoing the owner's rename would clobber the peer's title, so the API
    // refuses instead.
    const undoAttempt = await postUndo(canvas.id, cookie);
    expect(undoAttempt.status).toBe(409);
    expect(undoAttempt.body.error).toBe("undo_conflict");
    expect(undoAttempt.body.skipped).toEqual([
      { action: "canvas.updated", targetName: "Renamed by A", reason: "conflict" },
    ]);
    const afterUndo = await request("GET", `/api/canvases/${canvas.id}`, { cookie });
    expect(afterUndo.status).toBe(200);
    const current = (await afterUndo.json()) as { name: string; description: string };
    expect(current.name).toBe("Renamed by B");
    expect(current.description).toBe("");
  });
});

describe("Canvas undo survives a connector whose endpoint was undone away", () => {
  it("skips the connector restore instead of failing with a foreign-key error", async () => {
    const peerEmail = `undo-endpoint-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Endpoint Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Dangle WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Dangle canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    // The peer creates one endpoint; the owner creates the other and connects them.
    const invitationResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);
    const queueResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie: peerCookie },
      { type: "database", name: "Queue", x: 400, y: 20, parentEntityId: null },
    );
    expect(queueResponse.status).toBe(201);
    const queue = (await queueResponse.json()) as { id: string };
    const portResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "gateway", name: "Port", x: 10, y: 20, parentEntityId: null },
    );
    expect(portResponse.status).toBe(201);
    const port = (await portResponse.json()) as { id: string };
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie },
      { sourceEntityId: port.id, targetEntityId: queue.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);
    const connected = await graph(canvas.id);
    const connectionId = connected.connections[0]?.id;
    expect(connectionId).toBeDefined();

    // Step 1: the owner deletes the connector.
    const deleteResponse = await request("DELETE", `/api/canvases/${canvas.id}/connections/${connectionId}`, {
      cookie,
    });
    expect(deleteResponse.status).toBe(200);

    // Step 2: the peer undoes their node creation, removing the Queue endpoint
    // (the connector row is gone already, so the deletion cascades cleanly).
    const peerUndo = await undoByCookie(canvas.id, peerCookie);
    expect(peerUndo).toEqual({ undone: true, action: "entity.created", skipped: [] });
    const afterPeerUndo = await graph(canvas.id);
    expect(afterPeerUndo.entities.map((entity) => entity.id)).toEqual([port.id]);

    // Step 3: the owner's undo would restore the connector with a dangling
    // foreign key, so that candidate is skipped, never 500. The walk-back
    // honestly reports the no-op connector creation and keeps going until it
    // reaches a change that is still visible: removing the Port node.
    const ownerUndo = await postUndo(canvas.id, cookie);
    expect(ownerUndo.status).toBe(200);
    expect(ownerUndo.body).toEqual({
      undone: true,
      action: "entity.created",
      skipped: [
        { action: "connection.deleted", targetName: "Connection", reason: "conflict" },
        { action: "connection.created", targetName: "Port → Queue", reason: "no-op" },
      ],
    });
    const final = await graph(canvas.id);
    expect(final.entities).toHaveLength(0);
    expect(final.connections).toHaveLength(0);

    // A further undo only has the permanently blocked connector delete left,
    // so the API refuses instead of pretending something was reverted.
    const drained = await postUndo(canvas.id, cookie);
    expect(drained.status).toBe(409);
    expect(drained.body.skipped).toEqual([
      { action: "connection.deleted", targetName: "Connection", reason: "conflict" },
    ]);
  });
});

describe("Canvas undo keeps subtree restores off missing endpoints", () => {
  it("skips a node restore whose snapshot connector points at an undone-away endpoint", async () => {
    const peerEmail = `undo-subtree-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Subtree Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Subtree WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Subtree canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The peer owns Queue; the owner owns Port and links them.
    const queueResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie: peerCookie },
      { type: "database", name: "Queue", x: 400, y: 20, parentEntityId: null },
    );
    expect(queueResponse.status).toBe(201);
    const queue = (await queueResponse.json()) as { id: string };
    const portResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "gateway", name: "Port", x: 10, y: 20, parentEntityId: null },
    );
    expect(portResponse.status).toBe(201);
    const port = (await portResponse.json()) as { id: string };
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie },
      { sourceEntityId: port.id, targetEntityId: queue.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);

    // The owner deletes the Port node; the delete snapshot records the
    // Port → Queue connector as part of the subtree.
    const deleteResponse = await request("DELETE", `/api/canvases/${canvas.id}/entities/${port.id}`, { cookie });
    expect(deleteResponse.status).toBe(200);

    // The peer then undoes their node creation, so the Queue endpoint (and the
    // dangling connector row it still referenced) disappears for good.
    const peerUndo = await undoByCookie(canvas.id, peerCookie);
    expect(peerUndo).toEqual({ undone: true, action: "entity.created", skipped: [] });

    // The owner's undo would re-insert the snapshot connector against the
    // missing Queue entity, so the subtree restore is skipped instead of
    // failing with a foreign-key error. Every other event of the owner is
    // already a no-op (the Port node was deleted by the owner themselves), so
    // the API honestly refuses instead of claiming something was reverted.
    const ownerUndo = await postUndo(canvas.id, cookie);
    expect(ownerUndo.status).toBe(409);
    expect(ownerUndo.body.error).toBe("undo_conflict");
    expect(ownerUndo.body.skipped).toEqual([
      { action: "entity.deleted", targetName: "Port", reason: "conflict" },
      { action: "connection.created", targetName: "Port → Queue", reason: "no-op" },
      { action: "entity.created", targetName: "Port", reason: "no-op" },
    ]);
    const final = await graph(canvas.id);
    // Port was deleted by its owner, Queue by the peer's undo: the canvas is
    // honestly empty rather than holding a resurrected dangling connector.
    expect(final.entities).toHaveLength(0);
    expect(final.placements).toHaveLength(0);
    expect(final.connections).toHaveLength(0);
  });
});

describe("Canvas undo keeps placement restores off missing entities", () => {
  it("skips the movement restore instead of failing with a foreign-key error", async () => {
    const peerEmail = `undo-move-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Move Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Move WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Move canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The peer owns Queue; the owner creates Port, moves it, links it, and
    // finally deletes the Port node.
    const queueResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie: peerCookie },
      { type: "database", name: "Queue", x: 400, y: 20, parentEntityId: null },
    );
    expect(queueResponse.status).toBe(201);
    const queue = (await queueResponse.json()) as { id: string };
    const portResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "gateway", name: "Port", x: 10, y: 20, parentEntityId: null },
    );
    expect(portResponse.status).toBe(201);
    const port = (await portResponse.json()) as { id: string };
    const moveResponse = await request(
      "PUT",
      `/api/canvases/${canvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: port.id, parentEntityId: null, x: 300, y: 400, width: 220, height: 120 }] },
    );
    expect(moveResponse.status).toBe(200);
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/connections`,
      { cookie },
      { sourceEntityId: port.id, targetEntityId: queue.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);
    const deleteResponse = await request("DELETE", `/api/canvases/${canvas.id}/entities/${port.id}`, { cookie });
    expect(deleteResponse.status).toBe(200);

    // The peer undoes their node creation, removing the Queue endpoint.
    const peerUndo = await undoByCookie(canvas.id, peerCookie);
    expect(peerUndo).toEqual({ undone: true, action: "entity.created", skipped: [] });

    // The owner's undo walk: the subtree restore is blocked (its snapshot
    // connector points at the removed Queue), the connector creation is a
    // no-op, and the movement restore must be skipped too — re-inserting the
    // Port placement would violate the entity foreign key. Nothing is left
    // that can be honestly undone.
    const ownerUndo = await postUndo(canvas.id, cookie);
    expect(ownerUndo.status).toBe(409);
    expect(ownerUndo.body.error).toBe("undo_conflict");
    expect(ownerUndo.body.skipped).toEqual([
      { action: "entity.deleted", targetName: "Port", reason: "conflict" },
      { action: "connection.created", targetName: "Port → Queue", reason: "no-op" },
      { action: "placement.updated", targetName: "Port", reason: "conflict" },
      { action: "entity.created", targetName: "Port", reason: "no-op" },
    ]);
    const final = await graph(canvas.id);
    expect(final.entities).toHaveLength(0);
    expect(final.placements).toHaveLength(0);
    expect(final.connections).toHaveLength(0);
  });
});

describe("Canvas undo honestly reports updates with nothing to change", () => {
  it("reports nothing undone when the updated entity is already gone", async () => {
    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Rename WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const canvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Rename canvas", description: "" },
    );
    expect(canvasResponse.status).toBe(201);
    const canvas = (await canvasResponse.json()) as { id: string };
    const portResponse = await request(
      "POST",
      `/api/canvases/${canvas.id}/entities`,
      { cookie },
      { type: "gateway", name: "Port", x: 10, y: 20, parentEntityId: null },
    );
    expect(portResponse.status).toBe(201);
    const port = (await portResponse.json()) as { id: string };
    const renameResponse = await request("PATCH", `/api/entities/${port.id}`, { cookie }, { name: "Renamed by A" });
    expect(renameResponse.status).toBe(200);

    // Simulate the row vanishing without any active event (e.g. residue from
    // an older data state): a collaborator-driven delete would normally be
    // blocked by the conflict check, so this exercises the second line of
    // defense inside applyUndo directly.
    await db.delete(canvasNodes).where(eq(canvasNodes.entityId, port.id));
    await db.delete(entities).where(eq(entities.id, port.id));

    // The owner's only event now targets an entity that no longer exists: the
    // API must report that nothing was undone, not claim a phantom revert.
    const ownerUndo = await postUndo(canvas.id, cookie);
    expect(ownerUndo.status).toBe(200);
    expect(ownerUndo.body).toEqual({ undone: false });
    const final = await graph(canvas.id);
    expect(final.entities).toHaveLength(0);
    expect(final.placements).toHaveLength(0);
    expect(final.connections).toHaveLength(0);
  });
});

describe("Canvas undo removes placements that an event added", () => {
  it("undoes a from-null placement addition and still respects collaborator moves", async () => {
    const peerEmail = `undo-add-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Add Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request("POST", "/api/workspaces", { cookie }, { name: "Add WS", description: "" });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const firstCanvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Home canvas", description: "" },
    );
    expect(firstCanvasResponse.status).toBe(201);
    const homeCanvas = (await firstCanvasResponse.json()) as { id: string };
    const secondCanvasResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Board canvas", description: "" },
    );
    expect(secondCanvasResponse.status).toBe(201);
    const boardCanvas = (await secondCanvasResponse.json()) as { id: string };

    // The entity lives on the home canvas; adding it to the board canvas
    // records a placement.updated event whose entry has from: null.
    const entityResponse = await request(
      "POST",
      `/api/canvases/${homeCanvas.id}/entities`,
      { cookie },
      { type: "service", name: "Shared", x: 10, y: 20, parentEntityId: null },
    );
    expect(entityResponse.status).toBe(201);
    const shared = (await entityResponse.json()) as { id: string };
    const placement = { entityId: shared.id, parentEntityId: null, x: 50, y: 60, width: 220, height: 120 };
    const addResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      { placements: [placement] },
    );
    expect(addResponse.status).toBe(200);
    expect((await graph(boardCanvas.id)).placements).toHaveLength(1);

    // Undo must remove the placement the event added, not report nothing.
    expect(await undo(boardCanvas.id)).toEqual({ undone: true, action: "placement.updated", skipped: [] });
    const afterUndo = await graph(boardCanvas.id);
    expect(afterUndo.placements).toHaveLength(0);
    // The entity itself still exists on its home canvas.
    expect((await graph(homeCanvas.id)).placements).toHaveLength(1);

    // Adding it again and letting a collaborator move it afterwards must make
    // the owner's undo refuse instead of deleting the collaborator's state.
    const invitationResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);
    const reAddResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      { placements: [placement] },
    );
    expect(reAddResponse.status).toBe(200);
    const peerMove = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie: peerCookie },
      { placements: [{ ...placement, x: 700, y: 800 }] },
    );
    expect(peerMove.status).toBe(200);

    const conflictUndo = await postUndo(boardCanvas.id, cookie);
    expect(conflictUndo.status).toBe(409);
    expect(conflictUndo.body.error).toBe("undo_conflict");
    expect(conflictUndo.body.skipped).toEqual([
      { action: "placement.updated", targetName: "Shared", reason: "conflict" },
    ]);
    const final = await graph(boardCanvas.id);
    expect(final.placements).toHaveLength(1);
    expect(final.placements[0]).toMatchObject({ entityId: shared.id, x: 700, y: 800 });
  });
});

describe("Canvas undo keeps added placements collaborators depend on", () => {
  it("skips undoing an added placement when a collaborator connected it", async () => {
    const peerEmail = `undo-dep-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Dep Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request("POST", "/api/workspaces", { cookie }, { name: "Dep WS", description: "" });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const homeResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Dep home", description: "" },
    );
    expect(homeResponse.status).toBe(201);
    const homeCanvas = (await homeResponse.json()) as { id: string };
    const boardResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Dep board", description: "" },
    );
    expect(boardResponse.status).toBe(201);
    const boardCanvas = (await boardResponse.json()) as { id: string };

    // The owner adds an existing node's placement to the board (from: null)
    // and creates a second node there.
    const hubResponse = await request(
      "POST",
      `/api/canvases/${homeCanvas.id}/entities`,
      { cookie },
      { type: "gateway", name: "Hub", x: 10, y: 20, parentEntityId: null },
    );
    expect(hubResponse.status).toBe(201);
    const hub = (await hubResponse.json()) as { id: string };
    const addResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: hub.id, parentEntityId: null, x: 50, y: 60, width: 220, height: 120 }] },
    );
    expect(addResponse.status).toBe(200);
    const spokeResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/entities`,
      { cookie },
      { type: "service", name: "Spoke", x: 400, y: 20, parentEntityId: null },
    );
    expect(spokeResponse.status).toBe(201);
    const spoke = (await spokeResponse.json()) as { id: string };

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The collaborator connects the added placement to the other node.
    const connectionResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/connections`,
      { cookie: peerCookie },
      { sourceEntityId: hub.id, targetEntityId: spoke.id, type: "rest" },
    );
    expect(connectionResponse.status).toBe(201);

    // Undoing the placement addition would leave the connector dangling on an
    // unplaced endpoint, and undoing the node creation would delete the
    // connector outright: both must be skipped, never applied.
    const ownerUndo = await postUndo(boardCanvas.id, cookie);
    expect(ownerUndo.status).toBe(409);
    expect(ownerUndo.body.error).toBe("undo_conflict");
    expect(ownerUndo.body.skipped).toEqual([
      { action: "entity.created", targetName: "Spoke", reason: "conflict" },
      { action: "placement.updated", targetName: "Hub", reason: "conflict" },
    ]);
    const final = await graph(boardCanvas.id);
    expect(final.placements.map((placement) => placement.entityId).sort()).toEqual([hub.id, spoke.id].sort());
    expect(final.connections).toHaveLength(1);
    expect(final.connections[0]).toMatchObject({ sourceEntityId: hub.id, targetEntityId: spoke.id });
  });

  it("skips undoing an added placement when a collaborator parented a child under it", async () => {
    const peerEmail = `undo-child-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Child Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceResponse = await request(
      "POST",
      "/api/workspaces",
      { cookie },
      { name: "Child WS", description: "" },
    );
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    const homeResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Child home", description: "" },
    );
    expect(homeResponse.status).toBe(201);
    const homeCanvas = (await homeResponse.json()) as { id: string };
    const boardResponse = await request(
      "POST",
      "/api/canvases",
      { cookie },
      { workspaceId: workspace.id, name: "Child board", description: "" },
    );
    expect(boardResponse.status).toBe(201);
    const boardCanvas = (await boardResponse.json()) as { id: string };

    // Hub lives on the home canvas; the owner adds its placement to the board
    // (from: null) so that an addition event exists to undo.
    const hubResponse = await request(
      "POST",
      `/api/canvases/${homeCanvas.id}/entities`,
      { cookie },
      { type: "system", name: "Hub", x: 10, y: 20, parentEntityId: null },
    );
    expect(hubResponse.status).toBe(201);
    const hub = (await hubResponse.json()) as { id: string };
    const addResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: hub.id, parentEntityId: null, x: 50, y: 60, width: 440, height: 360 }] },
    );
    expect(addResponse.status).toBe(200);

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The collaborator adds a child node parented under Hub.
    const childResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/entities`,
      { cookie: peerCookie },
      { type: "service", name: "Leaf", x: 30, y: 40, parentEntityId: hub.id },
    );
    expect(childResponse.status).toBe(201);
    const leaf = (await childResponse.json()) as { id: string };

    // Undoing the Hub placement addition would orphan the collaborator's
    // child, so the event must be skipped.
    const ownerUndo = await postUndo(boardCanvas.id, cookie);
    expect(ownerUndo.status).toBe(409);
    expect(ownerUndo.body.error).toBe("undo_conflict");
    expect(ownerUndo.body.skipped).toEqual([{ action: "placement.updated", targetName: "Hub", reason: "conflict" }]);
    const final = await graph(boardCanvas.id);
    expect(final.placements.map((placement) => placement.entityId).sort()).toEqual([hub.id, leaf.id].sort());
    expect(final.entities.map((entity) => entity.id).sort()).toEqual([hub.id, leaf.id].sort());
  });
});

describe("Canvas undo evaluates dependencies against the post-undo graph", () => {
  async function createCanvas(workspaceId: string, name: string): Promise<{ id: string }> {
    const canvasResponse = await request("POST", "/api/canvases", { cookie }, { workspaceId, name, description: "" });
    expect(canvasResponse.status).toBe(201);
    return (await canvasResponse.json()) as { id: string };
  }

  async function createWorkspace(name: string): Promise<string> {
    const workspaceResponse = await request("POST", "/api/workspaces", { cookie }, { name, description: "" });
    expect(workspaceResponse.status).toBe(201);
    const workspace = (await workspaceResponse.json()) as { id: string };
    return workspace.id;
  }

  async function createEntity(
    canvasId: string,
    name: string,
    options: { actorCookie?: string; parentEntityId?: string | null } = {},
  ): Promise<{ id: string }> {
    const response = await request(
      "POST",
      `/api/canvases/${canvasId}/entities`,
      { cookie: options.actorCookie ?? cookie },
      { type: "service", name, x: 10, y: 20, parentEntityId: options.parentEntityId ?? null },
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }

  it("undoes one event that added a parent and its child together", async () => {
    const workspaceId = await createWorkspace("Pair WS");
    const homeCanvas = await createCanvas(workspaceId, "Pair home");
    const boardCanvas = await createCanvas(workspaceId, "Pair board");

    const parent = await createEntity(homeCanvas.id, "Parent");
    const child = await createEntity(homeCanvas.id, "Child");

    // One PUT adds both placements (from: null) in a single event, the child
    // parented under the parent added by the same event.
    const addResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      {
        placements: [
          { entityId: parent.id, parentEntityId: null, x: 50, y: 60, width: 440, height: 360 },
          { entityId: child.id, parentEntityId: parent.id, x: 80, y: 90, width: 200, height: 120 },
        ],
      },
    );
    expect(addResponse.status).toBe(200);
    const added = await graph(boardCanvas.id);
    expect(added.placements).toHaveLength(2);
    expect(added.placements.find((placement) => placement.entityId === child.id)).toMatchObject({
      parentEntityId: parent.id,
    });

    // The undo deletes both placements the event added: the child is removed
    // by the same reversal, so it must not count as a live dependency.
    expect(await undo(boardCanvas.id)).toEqual({ undone: true, action: "placement.updated", skipped: [] });
    const afterUndo = await graph(boardCanvas.id);
    expect(afterUndo.placements).toHaveLength(0);

    // The original entities survive on their home canvas.
    const home = await graph(homeCanvas.id);
    expect(home.entities.map((entity) => entity.id).sort()).toEqual([parent.id, child.id].sort());
    expect(home.placements).toHaveLength(2);
  });

  it("still refuses when a collaborator parents a child under the subtree after the event", async () => {
    const peerEmail = `undo-pair-peer-${crypto.randomUUID().slice(0, 8)}@example.test`;
    resetLoginAttempts();
    const registered = await request(
      "POST",
      "/api/auth/register",
      {},
      { name: "Pair Peer", email: peerEmail, password, confirmPassword: password },
    );
    expect(registered.status).toBe(201);
    const peerLogin = await request("POST", "/api/auth/login", {}, { email: peerEmail, password });
    expect(peerLogin.status).toBe(200);
    const peerCookie = peerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

    const workspaceId = await createWorkspace("Pair guard WS");
    const homeCanvas = await createCanvas(workspaceId, "Pair guard home");
    const boardCanvas = await createCanvas(workspaceId, "Pair guard board");

    const parent = await createEntity(homeCanvas.id, "Parent");
    const child = await createEntity(homeCanvas.id, "Child");
    const addResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      {
        placements: [
          { entityId: parent.id, parentEntityId: null, x: 50, y: 60, width: 440, height: 360 },
          { entityId: child.id, parentEntityId: parent.id, x: 80, y: 90, width: 200, height: 120 },
        ],
      },
    );
    expect(addResponse.status).toBe(200);

    const invitationResponse = await request(
      "POST",
      `/api/canvases/${boardCanvas.id}/invitations`,
      { cookie },
      { role: "editor" },
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { token: string };
    const acceptResponse = await request("POST", `/api/invitations/${invitation.token}/accept`, { cookie: peerCookie });
    expect(acceptResponse.status).toBe(200);

    // The collaborator adds their own child under the same-event subtree.
    const leaf = await createEntity(boardCanvas.id, "Leaf", { actorCookie: peerCookie, parentEntityId: parent.id });

    // The collaborator's child survives the undo and still depends on the
    // deleted parent, so the whole event must be skipped and the graph kept.
    const ownerUndo = await postUndo(boardCanvas.id, cookie);
    expect(ownerUndo.status).toBe(409);
    expect(ownerUndo.body.error).toBe("undo_conflict");
    expect(ownerUndo.body.skipped).toEqual([
      { action: "placement.updated", targetName: "2 nodes", reason: "conflict" },
    ]);
    const final = await graph(boardCanvas.id);
    expect(final.placements.map((placement) => placement.entityId).sort()).toEqual(
      [parent.id, child.id, leaf.id].sort(),
    );
    expect(final.entities.map((entity) => entity.id).sort()).toEqual([parent.id, child.id, leaf.id].sort());
    expect(final.placements.find((placement) => placement.entityId === leaf.id)).toMatchObject({
      parentEntityId: parent.id,
    });
  });

  it("judges a mixed event by the post-undo graph, not the pre-undo state", async () => {
    const workspaceId = await createWorkspace("Mixed WS");
    const homeCanvas = await createCanvas(workspaceId, "Mixed home");
    const boardCanvas = await createCanvas(workspaceId, "Mixed board");

    const parent = await createEntity(homeCanvas.id, "Parent");
    const child = await createEntity(homeCanvas.id, "Child");

    // Older event: the child is placed on the board at the root.
    const firstResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      { placements: [{ entityId: child.id, parentEntityId: null, x: 50, y: 60, width: 200, height: 120 }] },
    );
    expect(firstResponse.status).toBe(200);

    // Newest event mixes both kinds of change: it adds a parent placement
    // (from: null) and moves the existing child under it (from: not null).
    const mixedResponse = await request(
      "PUT",
      `/api/canvases/${boardCanvas.id}/placements`,
      { cookie },
      {
        placements: [
          { entityId: parent.id, parentEntityId: null, x: 500, y: 20, width: 440, height: 360 },
          { entityId: child.id, parentEntityId: parent.id, x: 80, y: 90, width: 200, height: 120 },
        ],
      },
    );
    expect(mixedResponse.status).toBe(200);

    // Reversing the mixed event re-parents the child back to the root, so
    // after the whole event is undone nothing depends on the deleted parent
    // anymore: the guard must not be fooled by the pre-undo state.
    expect(await undo(boardCanvas.id)).toEqual({ undone: true, action: "placement.updated", skipped: [] });
    const afterUndo = await graph(boardCanvas.id);
    expect(afterUndo.placements).toHaveLength(1);
    expect(afterUndo.placements[0]).toMatchObject({
      entityId: child.id,
      parentEntityId: null,
      x: 50,
      y: 60,
      width: 200,
      height: 120,
    });
    // The parent entity itself survives: it is still placed on the home canvas.
    expect(afterUndo.entities.map((entity) => entity.id)).toEqual([child.id]);

    // The older addition event is still there to undo next: the child
    // placement it added is the only one left on the board.
    expect(await undo(boardCanvas.id)).toEqual({ undone: true, action: "placement.updated", skipped: [] });
    expect((await graph(boardCanvas.id)).placements).toHaveLength(0);
    expect((await graph(homeCanvas.id)).placements).toHaveLength(2);
  });
});
