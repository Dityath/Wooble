import { beforeEach, describe, expect, it } from "bun:test";
import { canvasConnections, canvasNodes, db } from "@wooble/db";
import { createApp } from "../src/app";
import { type RouteAccess, routeAccess } from "../src/lib/auth";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

// Test-only routes nested under an entity and a connection. They stand in for the documentation,
// contract, schema and comment routes planned there, which must get the object rule from the guard.
// The unclassified ones stand in for a new route nobody gave an access class.
const api = apiClient({
  configure: (app) => {
    app.get("/api/entities/:entityId/probe", () => ({ reached: true }));
    app.patch("/api/entities/:entityId/probe", () => ({ reached: true }));
    app.get("/api/connections/:connectionId/probe", () => ({ reached: true }));
    app.put("/api/connections/:connectionId/probe/:part", () => ({ reached: true }));
    app.get("/api/unclassified-probe", () => ({ reached: true }));
    app.post("/api/auth/probe", () => ({ reached: true }));
    app.get("/api/invitations/:token/probe", () => ({ reached: true }));
  },
});
beforeEach(() => resetLoginAttempts());

type Person = Awaited<ReturnType<typeof api.register>>;

async function joinCanvas(owner: Person, person: Person, canvasId: string, role: "editor" | "viewer") {
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
  expect((await api.request("POST", `/api/invitations/${token}/accept`, person.session)).status).toBe(200);
}

// Every route the app registers and its access class. A new route fails the inventory test until
// it is listed here, so its class is a reviewed decision rather than a side effect of its path.
const registeredRoutes: Record<string, RouteAccess> = {
  "GET /health": "health",
  "POST /api/auth/register": "auth",
  "POST /api/auth/login": "auth",
  "GET /api/auth/me": "profile",
  "POST /api/auth/logout": "profile",
  "PATCH /api/auth/profile": "profile",
  "PUT /api/auth/password": "profile",
  "GET /api/admin/users": "admin",
  "PATCH /api/admin/users/:userId": "admin",
  "GET /api/workspaces": "workspaces",
  "POST /api/workspaces": "workspaces",
  "GET /api/workspaces/:workspaceId": "workspaces",
  "PATCH /api/workspaces/:workspaceId": "workspaces",
  "GET /api/workspaces/:workspaceId/members": "workspaces",
  "POST /api/workspaces/:workspaceId/members": "workspaces",
  "PATCH /api/workspaces/:workspaceId/members/:userId": "workspaces",
  "DELETE /api/workspaces/:workspaceId/members/:userId": "workspaces",
  "POST /api/workspaces/:workspaceId/invitations": "workspaces",
  "GET /api/invitations/:token": "invitations",
  "POST /api/invitations/:token/accept": "invitations",
  "GET /api/canvases": "canvases",
  "POST /api/canvases": "canvases",
  "GET /api/canvases/:canvasId": "canvases",
  "GET /api/canvases/:canvasId/access": "canvases",
  "PATCH /api/canvases/:canvasId": "canvases",
  "DELETE /api/canvases/:canvasId": "canvases",
  "GET /api/canvases/:canvasId/members": "canvases",
  "POST /api/canvases/:canvasId/members": "canvases",
  "PATCH /api/canvases/:canvasId/members/:userId": "canvases",
  "DELETE /api/canvases/:canvasId/members/:userId": "canvases",
  "POST /api/canvases/:canvasId/invitations": "canvases",
  "GET /api/canvases/:canvasId/graph": "canvases",
  "GET /api/canvases/:canvasId/activity": "canvases",
  "POST /api/canvases/:canvasId/entities": "canvases",
  "POST /api/canvases/:canvasId/connections": "canvases",
  "PUT /api/canvases/:canvasId/connections/:connectionId/bend": "canvases",
  "PUT /api/canvases/:canvasId/auto-neat": "canvases",
  "DELETE /api/canvases/:canvasId/connections/:connectionId": "canvases",
  "DELETE /api/canvases/:canvasId/entities/:entityId": "canvases",
  "PUT /api/canvases/:canvasId/placements": "canvases",
  "POST /api/canvases/:canvasId/undo": "canvases",
  "WS /api/canvases/:canvasId/live": "live",
  "GET /api/entities/:entityId": "entities",
  "PATCH /api/entities/:entityId": "entities",
  "GET /api/connections/:connectionId": "connections",
  "PATCH /api/connections/:connectionId": "connections",
};

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

async function status(session: string | undefined, method: "GET" | "POST" | "PATCH" | "PUT", url: string) {
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

describe("route access classes", () => {
  it("cover every registered route", () => {
    const routes = createApp().routes.map((route) => ({ key: `${route.method} ${route.path}`, path: route.path }));

    expect(routes.filter((route) => !routeAccess(route.path)).map((route) => route.key)).toEqual([]);
    expect(Object.fromEntries(routes.map((route) => [route.key, routeAccess(route.path)]))).toEqual(registeredRoutes);
  });

  it("extend to nested routes only under a single resource", () => {
    expect(routeAccess("/api/entities/:entityId/documentation")).toBe("entities");
    expect(routeAccess("/api/connections/:connectionId/contract/revisions")).toBe("connections");
    expect(routeAccess("/api/canvases/:canvasId/comments/:threadId")).toBe("canvases");
    expect(routeAccess("/api/workspaces/:workspaceId/settings")).toBe("workspaces");
    expect(routeAccess("/api/admin/sessions")).toBe("admin");
    for (const route of [
      "/api",
      "/api/entities",
      "/api/entities/:id/documentation",
      "/api/entitiesearch",
      "/api/auth/sessions",
      "/api/invitations",
      "/api/invitations/:token/decline",
      "/api/administrators",
      "/api/notifications",
    ])
      expect(routeAccess(route)).toBeNull();
  });

  it("deny every caller on a route without a class", async () => {
    const member = await api.register("Unclassified Member");
    const admin = await api.register("Unclassified Admin");
    await api.promoteToAdmin(admin.user.id);
    const routes = [
      ["GET", "/api/unclassified-probe"],
      ["POST", "/api/auth/probe"],
      ["GET", `/api/invitations/${"t".repeat(32)}/probe`],
    ] as const;

    for (const [method, url] of routes) {
      expect(await status(member.session, method, url)).toBe(403);
      expect(await status(admin.session, method, url)).toBe(403);
      expect(await status(undefined, method, url)).toBe(401);
    }
    const denied = await api.json("GET", "/api/unclassified-probe", member.session);
    expect(denied.body).toEqual({ message: "You do not have access to this resource" });
  });
});

describe("invalid params and missing resources", () => {
  it("keep the handlers' 400 and 404 responses", async () => {
    const owner = await api.register("Missing Owner");
    const missing = crypto.randomUUID();
    const badRequest = (message: string) => ({ error: "bad_request", message });
    const notFound = (message: string) => ({ error: "not_found", message });
    const cases = [
      ["GET", "/api/entities/not-a-uuid", 400, badRequest("Entity ID must be a UUID")],
      ["GET", `/api/entities/${missing}`, 404, notFound("Entity not found")],
      ["PATCH", `/api/entities/${missing}`, 404, notFound("Entity not found")],
      ["GET", "/api/connections/not-a-uuid", 400, badRequest("Connection ID must be a UUID")],
      ["GET", `/api/connections/${missing}`, 404, notFound("Connection not found")],
      ["PATCH", `/api/connections/${missing}`, 404, notFound("Connection not found")],
      ["GET", "/api/workspaces/not-a-uuid", 400, badRequest("Workspace ID must be a UUID")],
      ["GET", "/api/canvases/not-a-uuid/graph", 400, badRequest("Canvas ID must be a UUID")],
    ] as const;

    for (const [method, url, code, body] of cases) {
      const response = await api.json(
        method,
        url,
        owner.session,
        method === "GET" ? undefined : { description: "Changed" },
      );
      expect([url, response.status, response.body]).toEqual([url, code, body]);
    }
  });

  it("let nested object routes answer them, and deny missing workspaces and canvases", async () => {
    const owner = await api.register("Missing Nested Owner");
    const admin = await api.register("Missing Nested Admin");
    await api.promoteToAdmin(admin.user.id);
    const missing = crypto.randomUUID();

    // Nothing to protect, so the guard leaves the 400 or 404 to the nested route's own handler.
    expect(await nested(owner.session, "entity", "not-a-uuid")).toEqual([200, 200]);
    expect(await nested(owner.session, "entity", missing)).toEqual([200, 200]);
    expect(await nested(owner.session, "connection", missing)).toEqual([200, 200]);
    expect(await nested(undefined, "entity", missing)).toEqual([401, 401]);
    // A workspace or canvas that does not exist looks like one the caller has no role on.
    expect(await status(owner.session, "GET", `/api/workspaces/${missing}`)).toBe(403);
    expect(await status(owner.session, "GET", `/api/canvases/${missing}/graph`)).toBe(403);
    expect(await status(admin.session, "GET", `/api/canvases/${missing}/graph`)).toBe(403);
    expect((await api.json("GET", `/api/workspaces/${missing}`, admin.session)).body).toEqual({
      error: "not_found",
      message: "Workspace not found",
    });
    expect(await status(undefined, "GET", "/api/canvases/not-a-uuid")).toBe(401);
    expect(await status(undefined, "GET", `/api/entities/${missing}?canvasId=${missing}`)).toBe(401);
  });
});
