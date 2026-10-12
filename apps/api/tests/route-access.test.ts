import { beforeEach, describe, expect, it } from "bun:test";
import { canvasConnections, canvasNodes, db } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

// Test-only routes nested under an entity and a connection. They stand in for the documentation,
// contract, schema and comment routes planned there, which must get the object rule from the guard.
const api = apiClient({
  configure: (app) => {
    app.get("/api/entities/:entityId/probe", () => ({ reached: true }));
    app.patch("/api/entities/:entityId/probe", () => ({ reached: true }));
    app.get("/api/connections/:connectionId/probe", () => ({ reached: true }));
    app.put("/api/connections/:connectionId/probe/:part", () => ({ reached: true }));
  },
});
beforeEach(() => resetLoginAttempts());

type Person = Awaited<ReturnType<typeof api.register>>;

async function joinCanvas(owner: Person, person: Person, canvasId: string, role: "editor" | "viewer") {
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
  expect((await api.request("POST", `/api/invitations/${token}/accept`, person.session)).status).toBe(200);
}

/**
 * Restricted Orders and Billing canvases that both show two nodes and their connection, a node only
 * Orders shows, and a node on a link-shared status page. The people are the workspace manager, a
 * system admin, an editor of both canvases, an editor of Orders only, an Orders viewer and an
 * outsider with no role.
 */
async function nestedFixture() {
  const owner = await api.register("Nested Owner");
  const orders = await api.createCanvas(owner.session, owner.workspaceId, "Orders");
  const billing = await api.createCanvas(owner.session, owner.workspaceId, "Billing");
  const statusPage = await api.createCanvas(owner.session, owner.workspaceId, "Status page");
  const source = await api.createNode(owner.session, orders, { name: "Orders API" });
  const target = await api.createNode(owner.session, orders, { type: "database", name: "Orders DB", x: 400 });
  const ordersOnly = await api.createNode(owner.session, orders, { name: "Audit log", y: 300 });
  const published = await api.createNode(owner.session, statusPage, { name: "Status API" });
  const connection = await api.connect(owner.session, orders, source, target);
  await db.insert(canvasNodes).values([
    { canvasId: billing, entityId: source },
    { canvasId: billing, entityId: target, x: 400 },
  ]);
  await db.insert(canvasConnections).values({ canvasId: billing, connectionId: connection });
  expect((await api.request("PATCH", `/api/canvases/${statusPage}`, owner.session, { shareMode: "link" })).status).toBe(
    200,
  );

  const admin = await api.register("Nested Admin");
  await api.promoteToAdmin(admin.user.id);
  const editor = await api.register("Nested Editor");
  await joinCanvas(owner, editor, orders, "editor");
  await joinCanvas(owner, editor, billing, "editor");
  const ordersEditor = await api.register("Nested Orders Editor");
  await joinCanvas(owner, ordersEditor, orders, "editor");
  const viewer = await api.register("Nested Viewer");
  await joinCanvas(owner, viewer, orders, "viewer");
  const outsider = await api.register("Nested Outsider");

  return {
    canvases: { orders, statusPage },
    objects: { source, ordersOnly, published, connection },
    people: { owner, admin, editor, ordersEditor, viewer, outsider },
  };
}

async function status(session: string | undefined, method: "GET" | "PATCH" | "PUT", url: string) {
  return (await api.request(method, url, session, method === "GET" ? undefined : {})).status;
}

/** The [read, write] statuses of the probes nested under an entity or a connection. */
async function nested(session: string | undefined, kind: "entity" | "connection", id: string, query = "") {
  return kind === "entity"
    ? [
        await status(session, "GET", `/api/entities/${id}/probe${query}`),
        await status(session, "PATCH", `/api/entities/${id}/probe${query}`),
      ]
    : [
        await status(session, "GET", `/api/connections/${id}/probe${query}`),
        await status(session, "PUT", `/api/connections/${id}/probe/part${query}`),
      ];
}

describe("routes nested under an entity or a connection", () => {
  it("follow the entity rule for every role", async () => {
    const { objects, people } = await nestedFixture();
    const { source, ordersOnly, published } = objects;

    expect(await nested(people.owner.session, "entity", ordersOnly)).toEqual([200, 200]);
    expect(await nested(people.admin.session, "entity", ordersOnly)).toEqual([200, 200]);
    expect(await nested(people.editor.session, "entity", source)).toEqual([200, 200]);
    expect(await nested(people.ordersEditor.session, "entity", ordersOnly)).toEqual([200, 200]);
    // Billing also shows this node, and the orders editor has no role there.
    expect(await nested(people.ordersEditor.session, "entity", source)).toEqual([200, 403]);
    expect(await nested(people.viewer.session, "entity", ordersOnly)).toEqual([200, 403]);
    expect(await nested(people.outsider.session, "entity", ordersOnly)).toEqual([403, 403]);
    // A signed-in link guest reads what a link-shared canvas shows, and cannot change it.
    expect(await nested(people.outsider.session, "entity", published)).toEqual([200, 403]);
  });

  it("follow the connection rule for every role", async () => {
    const { objects, people } = await nestedFixture();
    const { connection } = objects;

    expect(await nested(people.owner.session, "connection", connection)).toEqual([200, 200]);
    expect(await nested(people.admin.session, "connection", connection)).toEqual([200, 200]);
    expect(await nested(people.editor.session, "connection", connection)).toEqual([200, 200]);
    expect(await nested(people.ordersEditor.session, "connection", connection)).toEqual([200, 403]);
    expect(await nested(people.viewer.session, "connection", connection)).toEqual([200, 403]);
    expect(await nested(people.outsider.session, "connection", connection)).toEqual([403, 403]);
  });

  it("stay closed to signed-out visitors, even for what a link-shared canvas shows", async () => {
    const { canvases, objects } = await nestedFixture();
    const onStatusPage = `?canvasId=${canvases.statusPage}`;

    // The anonymous read of the entity itself is unchanged.
    expect((await api.request("GET", `/api/entities/${objects.published}${onStatusPage}`)).status).toBe(200);
    expect(await nested(undefined, "entity", objects.published, onStatusPage)).toEqual([401, 401]);
    expect(await nested(undefined, "entity", objects.published)).toEqual([401, 401]);
    expect(await nested(undefined, "entity", objects.ordersOnly, `?canvasId=${canvases.orders}`)).toEqual([401, 401]);
    expect(await nested(undefined, "connection", objects.connection)).toEqual([401, 401]);
  });
});
