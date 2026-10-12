import { beforeEach, describe, expect, it } from "bun:test";
import { canvasConnections, canvasNodes, db, entities } from "@wooble/db";
import { type Actor, objectAccess, objectOnCanvas } from "../src/lib/auth";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Person = Awaited<ReturnType<typeof api.register>>;

function actor(person: Person, systemRole: Actor["systemRole"] = "user"): Actor {
  return { id: person.user.id, name: person.user.name, email: person.user.email, systemRole };
}

async function joinCanvas(owner: Person, person: Person, canvasId: string, role: "editor" | "viewer") {
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
  expect((await api.request("POST", `/api/invitations/${token}/accept`, person.session)).status).toBe(200);
}

/** Two restricted canvases in one workspace that both show the same two nodes and their connection. */
async function sharedObjects() {
  const owner = await api.register("Object Owner");
  const orders = await api.createCanvas(owner.session, owner.workspaceId, "Orders");
  const billing = await api.createCanvas(owner.session, owner.workspaceId, "Billing");
  const source = await api.createNode(owner.session, orders, { name: "Orders API" });
  const target = await api.createNode(owner.session, orders, { type: "database", name: "Orders DB", x: 400 });
  const ordersOnly = await api.createNode(owner.session, orders, { name: "Audit log", y: 300 });
  const connection = await api.connect(owner.session, orders, source, target);
  await db.insert(canvasNodes).values([
    { canvasId: billing, entityId: source },
    { canvasId: billing, entityId: target, x: 400 },
  ]);
  await db.insert(canvasConnections).values({ canvasId: billing, connectionId: connection });
  return { owner, orders, billing, source, target, ordersOnly, connection };
}

async function access(person: Actor, kind: "entity" | "connection", id: string) {
  return [await objectAccess(person, kind, id, "read"), await objectAccess(person, kind, id, "write")];
}

describe("objectAccess", () => {
  it("lets workspace managers and system admins read and write without a canvas role", async () => {
    const { owner, source, connection } = await sharedObjects();
    const admin = await api.register("Object Admin");
    await api.promoteToAdmin(admin.user.id);

    for (const person of [actor(owner), actor(admin, "admin")]) {
      expect(await access(person, "entity", source)).toEqual(["allowed", "allowed"]);
      expect(await access(person, "connection", connection)).toEqual(["allowed", "allowed"]);
    }
  });

  it("reads with a role on any showing canvas and writes only as editor on every one", async () => {
    const { owner, orders, billing, source, ordersOnly, connection } = await sharedObjects();
    const editorOfBoth = await api.register("Editor Of Both");
    const ordersEditor = await api.register("Orders Editor");
    const ordersViewer = await api.register("Orders Viewer");
    const outsider = await api.register("Object Outsider");
    await joinCanvas(owner, editorOfBoth, orders, "editor");
    await joinCanvas(owner, editorOfBoth, billing, "editor");
    await joinCanvas(owner, ordersEditor, orders, "editor");
    await joinCanvas(owner, ordersViewer, orders, "viewer");

    expect(await access(actor(editorOfBoth), "entity", source)).toEqual(["allowed", "allowed"]);
    expect(await access(actor(editorOfBoth), "connection", connection)).toEqual(["allowed", "allowed"]);
    // Billing also shows these, and the orders editor has no role there.
    expect(await access(actor(ordersEditor), "entity", source)).toEqual(["allowed", "denied"]);
    expect(await access(actor(ordersEditor), "connection", connection)).toEqual(["allowed", "denied"]);
    expect(await access(actor(ordersEditor), "entity", ordersOnly)).toEqual(["allowed", "allowed"]);
    expect(await access(actor(ordersViewer), "entity", ordersOnly)).toEqual(["allowed", "denied"]);
    expect(await access(actor(ordersViewer), "connection", connection)).toEqual(["allowed", "denied"]);
    expect(await access(actor(outsider), "entity", source)).toEqual(["denied", "denied"]);
    expect(await access(actor(outsider), "connection", connection)).toEqual(["denied", "denied"]);
  });

  it("lets anyone read what a link-shared canvas shows, but not change it", async () => {
    const { owner, orders, ordersOnly, connection } = await sharedObjects();
    const visitor = await api.register("Object Visitor");
    expect(await access(actor(visitor), "entity", ordersOnly)).toEqual(["denied", "denied"]);

    await api.request("PATCH", `/api/canvases/${orders}`, owner.session, { shareMode: "link" });
    expect(await access(actor(visitor), "entity", ordersOnly)).toEqual(["allowed", "denied"]);
    expect(await access(actor(visitor), "connection", connection)).toEqual(["allowed", "denied"]);
  });

  it("ignores canvases of another workspace that show the object", async () => {
    const { source, connection } = await sharedObjects();
    const stranger = await api.register("Object Stranger");
    const strangerCanvas = await api.createCanvas(stranger.session, stranger.workspaceId, "Elsewhere");
    await api.request("PATCH", `/api/canvases/${strangerCanvas}`, stranger.session, { shareMode: "link" });
    await db.insert(canvasNodes).values({ canvasId: strangerCanvas, entityId: source });
    await db.insert(canvasConnections).values({ canvasId: strangerCanvas, connectionId: connection });

    expect(await access(actor(stranger), "entity", source)).toEqual(["denied", "denied"]);
    expect(await access(actor(stranger), "connection", connection)).toEqual(["denied", "denied"]);
  });

  it("denies objects no canvas shows to everyone but managers, and reports missing ones", async () => {
    const { owner, orders } = await sharedObjects();
    const editor = await api.register("Unplaced Editor");
    await joinCanvas(owner, editor, orders, "editor");
    const [unplaced] = await db
      .insert(entities)
      .values({ workspaceId: owner.workspaceId, type: "service", name: "Unplaced" })
      .returning({ id: entities.id });

    expect(await access(actor(editor), "entity", unplaced.id)).toEqual(["denied", "denied"]);
    expect(await access(actor(owner), "entity", unplaced.id)).toEqual(["allowed", "allowed"]);
    expect(await access(actor(owner), "entity", crypto.randomUUID())).toEqual(["missing", "missing"]);
    expect(await access(actor(owner), "connection", crypto.randomUUID())).toEqual(["missing", "missing"]);
  });
});

describe("objectOnCanvas", () => {
  it("tells whether a canvas shows a node or a connection", async () => {
    const { owner, orders, billing, source, ordersOnly, connection } = await sharedObjects();
    const unrelated = await api.createCanvas(owner.session, owner.workspaceId, "Unrelated");

    expect(await objectOnCanvas("entity", source, orders)).toBe(true);
    expect(await objectOnCanvas("entity", source, billing)).toBe(true);
    expect(await objectOnCanvas("entity", ordersOnly, billing)).toBe(false);
    expect(await objectOnCanvas("connection", connection, billing)).toBe(true);
    expect(await objectOnCanvas("connection", connection, unrelated)).toBe(false);
    expect(await objectOnCanvas("entity", connection, orders)).toBe(false);
  });
});

describe("entity and connection routes", () => {
  it("refuse a write from an editor of only one of the canvases that show the object", async () => {
    const { owner, orders, source, ordersOnly, connection } = await sharedObjects();
    const ordersEditor = await api.register("Route Editor");
    await joinCanvas(owner, ordersEditor, orders, "editor");

    expect((await api.request("GET", `/api/entities/${source}`, ordersEditor.session)).status).toBe(200);
    expect((await api.request("PATCH", `/api/entities/${source}`, ordersEditor.session, { name: "No" })).status).toBe(
      403,
    );
    expect(
      (await api.request("PATCH", `/api/entities/${ordersOnly}`, ordersEditor.session, { name: "Yes" })).status,
    ).toBe(200);
    expect((await api.request("GET", `/api/connections/${connection}`, ordersEditor.session)).status).toBe(200);
    expect(
      (await api.request("PATCH", `/api/connections/${connection}`, ordersEditor.session, { label: "No" })).status,
    ).toBe(403);
  });
});
