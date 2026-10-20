import { beforeEach, describe, expect, it } from "bun:test";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type CanvasSummary = { id: string; name: string; workspaceId: string; systemCount: number; serviceCount: number };
type Graph = {
  canvas: { updatedAt: string; shareMode: string };
  placements: Array<{
    entityId: string;
    parentEntityId: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  connections: Array<{ id: string; bend: unknown }>;
};

describe("canvas library", () => {
  it("lists managed and shared canvases with node counts", async () => {
    const owner = await api.register("Library Owner");
    const viewer = await api.register("Library Viewer");
    const loner = await api.register("Library Loner");
    const alpha = await api.createCanvas(owner.session, owner.workspaceId, "Alpha");
    const beta = await api.createCanvas(owner.session, owner.workspaceId, "Beta");
    const system = await api.createNode(owner.session, alpha, { type: "system", name: "Storefront" });
    await api.createNode(owner.session, alpha, { name: "Orders", x: 20, y: 60, parentEntityId: system });
    await api.createNode(owner.session, alpha, { name: "Billing", x: 600 });
    await api.json(
      "POST",
      `/api/invitations/${await api.invite(owner.session, `/api/canvases/${beta}/invitations`, "viewer")}/accept`,
      viewer.session,
    );

    const mine = await api.json<CanvasSummary[]>("GET", "/api/canvases", owner.session);
    expect(mine.body.map((canvas) => canvas.name)).toEqual(["Alpha", "Beta"]);
    expect(mine.body[0]).toMatchObject({ id: alpha, systemCount: 1, serviceCount: 2 });
    expect(mine.body[1]).toMatchObject({ id: beta, systemCount: 0, serviceCount: 0 });

    const shared = await api.json<CanvasSummary[]>("GET", "/api/canvases", viewer.session);
    expect(shared.body.filter((canvas) => canvas.workspaceId === owner.workspaceId).map((canvas) => canvas.id)).toEqual(
      [beta],
    );

    // A person removed from their only workspace by a co-manager sees no canvases and no workspaces.
    await api.request("POST", `/api/workspaces/${loner.workspaceId}/members`, loner.session, {
      email: owner.user.email,
      role: "manager",
    });
    await api.request("DELETE", `/api/workspaces/${loner.workspaceId}/members/${loner.user.id}`, owner.session);
    expect((await api.json<Array<{ id: string }>>("GET", "/api/workspaces", loner.session)).body).toEqual([]);
    expect((await api.json<CanvasSummary[]>("GET", "/api/canvases", loner.session)).body).toEqual([]);
  });

  it("shows system admins every canvas", async () => {
    const owner = await api.register("Visible Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Visible to admins");
    const admin = await api.register("Library Admin");
    await api.promoteToAdmin(admin.user.id);
    const all = await api.json<CanvasSummary[]>("GET", "/api/canvases", admin.session);
    expect(all.body.some((canvas) => canvas.id === canvasId)).toBe(true);
  });

  it("validates new canvases", async () => {
    const owner = await api.register("Canvas Validator");
    expect(
      (await api.request("POST", "/api/canvases", owner.session, { workspaceId: owner.workspaceId, name: "" })).status,
    ).toBe(400);
  });
});

describe("canvas settings", () => {
  it("renames, shares, and deletes a canvas", async () => {
    const owner = await api.register("Settings Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Draft");
    const url = `/api/canvases/${canvasId}`;

    const renamed = await api.json<{ name: string; description: string; shareMode: string }>(
      "PATCH",
      url,
      owner.session,
      {
        name: " Final ",
        description: "Reviewed",
        shareMode: "link",
      },
    );
    expect(renamed.body).toMatchObject({ name: "Final", description: "Reviewed", shareMode: "link" });
    expect((await api.json<{ name: string }>("GET", url, owner.session)).body.name).toBe("Final");
    const activity = await api.json<{ events: Array<{ action: string; metadata: Record<string, unknown> }> }>(
      "GET",
      `${url}/activity`,
      owner.session,
    );
    expect(activity.body.events[0]).toMatchObject({
      action: "canvas.updated",
      metadata: { fields: ["name", "description", "shareMode"] },
    });
    expect(activity.body.events[0].metadata).not.toHaveProperty("previous");

    expect((await api.request("PATCH", url, owner.session, {})).status).toBe(400);
    expect((await api.request("PATCH", url, owner.session, { shareMode: "public" })).status).toBe(400);
    expect((await api.request("DELETE", url, owner.session)).status).toBe(200);
    expect((await api.request("GET", "/api/canvases", owner.session)).status).toBe(200);
    expect((await api.request("GET", url, owner.session)).status).toBe(403);
  });

  it("reserves settings for managers", async () => {
    const owner = await api.register("Reserved Owner");
    const editor = await api.register("Reserved Editor");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    await api.json(
      "POST",
      `/api/invitations/${await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor")}/accept`,
      editor.session,
    );
    const url = `/api/canvases/${canvasId}`;
    expect((await api.request("PATCH", url, editor.session, { name: "Mine" })).status).toBe(403);
    expect((await api.request("DELETE", url, editor.session)).status).toBe(403);
    expect((await api.request("GET", `${url}/members`, editor.session)).status).toBe(403);
    expect((await api.request("GET", url, editor.session)).status).toBe(200);
  });
});

describe("canvas members", () => {
  it("adds, re-roles, lists, and removes canvas members", async () => {
    const owner = await api.register("Canvas Member Owner");
    const colleague = await api.register("Canvas Member Colleague");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    const base = `/api/canvases/${canvasId}/members`;

    const added = await api.json<{ id: string; role: string }>("POST", base, owner.session, {
      email: colleague.user.email.toUpperCase(),
      role: "viewer",
    });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ id: colleague.user.id, role: "viewer" });
    const workspace = await api.json<{ role: string }>(
      "GET",
      `/api/workspaces/${owner.workspaceId}`,
      colleague.session,
    );
    expect(workspace.body.role).toBe("member");

    expect(
      (await api.json<{ role: string }>("POST", base, owner.session, { email: colleague.user.email, role: "editor" }))
        .body.role,
    ).toBe("editor");
    const changed = await api.json<{ id: string; role: string }>(
      "PATCH",
      `${base}/${colleague.user.id}`,
      owner.session,
      {
        role: "viewer",
      },
    );
    expect(changed.body).toEqual({ id: colleague.user.id, role: "viewer" });
    const list = await api.json<Array<{ id: string; role: string }>>("GET", base, owner.session);
    expect(list.body).toEqual([expect.objectContaining({ id: colleague.user.id, role: "viewer" })]);

    expect((await api.request("DELETE", `${base}/${colleague.user.id}`, owner.session)).status).toBe(200);
    expect((await api.request("GET", `/api/canvases/${canvasId}/graph`, colleague.session)).status).toBe(403);
  });

  it("rejects invalid or unknown members", async () => {
    const owner = await api.register("Canvas Member Checker");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    const base = `/api/canvases/${canvasId}/members`;
    expect(
      (await api.request("POST", base, owner.session, { email: "nobody@example.test", role: "viewer" })).status,
    ).toBe(404);
    expect((await api.request("POST", base, owner.session, { email: "bad", role: "viewer" })).status).toBe(400);
    expect(
      (await api.request("PATCH", `${base}/${crypto.randomUUID()}`, owner.session, { role: "viewer" })).status,
    ).toBe(404);
    expect((await api.request("PATCH", `${base}/not-a-uuid`, owner.session, { role: "viewer" })).status).toBe(400);
    expect((await api.request("DELETE", `${base}/not-a-uuid`, owner.session)).status).toBe(400);
  });
});

describe("connector routes and layout", () => {
  async function canvasWithConnection() {
    const owner = await api.register("Route Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    const a = await api.createNode(owner.session, canvasId, { name: "A" });
    const b = await api.createNode(owner.session, canvasId, { name: "B", x: 500 });
    const connectionId = await api.connect(owner.session, canvasId, a, b);
    return { owner, canvasId, a, b, connectionId };
  }

  it("saves and clears a connector route", async () => {
    const { owner, canvasId, connectionId } = await canvasWithConnection();
    const url = `/api/canvases/${canvasId}/connections/${connectionId}/bend`;
    const path = [
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ];
    expect((await api.json<{ bend: unknown }>("PUT", url, owner.session, { bend: path })).body).toEqual({ bend: path });
    let graph = await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session);
    expect(graph.body.connections[0].bend).toEqual(path);
    await api.request("PUT", url, owner.session, { bend: null });
    graph = await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session);
    expect(graph.body.connections[0].bend).toBeNull();

    const tooMany = Array.from({ length: 13 }, (_, index) => ({ x: index, y: index }));
    expect((await api.request("PUT", url, owner.session, { bend: tooMany })).status).toBe(400);
    expect(
      (await api.request("PUT", `/api/canvases/${canvasId}/connections/nope/bend`, owner.session, { bend: null }))
        .status,
    ).toBe(400);
    const missing = await api.json<{ message: string }>(
      "PUT",
      `/api/canvases/${canvasId}/connections/${crypto.randomUUID()}/bend`,
      owner.session,
      { bend: null },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Canvas connection not found");
  });

  it("rejects Auto Neat layouts built from a stale canvas", async () => {
    const { owner, canvasId, a, b, connectionId } = await canvasWithConnection();
    const graph = (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
    const layout = {
      expectedUpdatedAt: graph.canvas.updatedAt,
      placements: graph.placements.map((placement) => ({ ...placement, x: placement.x + 10 })),
      connections: [{ connectionId, bend: { x: 250, y: 60 } }],
    };
    const url = `/api/canvases/${canvasId}/auto-neat`;

    const stale = await api.json<{ error: string }>("PUT", url, owner.session, {
      ...layout,
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("layout_conflict");
    expect(
      (await api.request("PUT", url, owner.session, { ...layout, placements: layout.placements.slice(1) })).status,
    ).toBe(409);
    expect(
      (
        await api.request("PUT", url, owner.session, {
          ...layout,
          placements: layout.placements.map((placement) =>
            placement.entityId === a ? { ...placement, parentEntityId: b } : placement,
          ),
        })
      ).status,
    ).toBe(409);
    expect((await api.request("PUT", url, owner.session, { ...layout, connections: [] })).status).toBe(409);
    expect((await api.request("PUT", url, owner.session, { ...layout, expectedUpdatedAt: "soon" })).status).toBe(400);

    const saved = await api.json<{ kind: string; updatedAt: string }>("PUT", url, owner.session, layout);
    expect(saved.body.kind).toBe("saved");
    const after = (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
    expect(after.placements.map((placement) => placement.x).sort()).toEqual(
      layout.placements.map((placement) => placement.x).sort(),
    );
    expect(after.connections[0].bend).toEqual({ x: 250, y: 60 });
  });

  it("saves Auto Neat multi-waypoint routes as arrays", async () => {
    const { owner, canvasId, connectionId } = await canvasWithConnection();
    const graph = (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
    const path = [
      { x: 250, y: 60 },
      { x: 250, y: 140 },
    ];
    const saved = await api.json<{ kind: string }>("PUT", `/api/canvases/${canvasId}/auto-neat`, owner.session, {
      expectedUpdatedAt: graph.canvas.updatedAt,
      placements: graph.placements.map((placement) => ({ ...placement, x: placement.x + 10 })),
      connections: [{ connectionId, bend: path }],
    });
    expect(saved.body.kind).toBe("saved");
    const after = (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
    expect(after.connections[0].bend).toEqual(path);
  });

  it("only lets people who can already edit an entity place it on another canvas", async () => {
    const owner = await api.register("Placement Owner");
    const editor = await api.register("Placement Editor");
    const viewer = await api.register("Placement Viewer");
    const restricted = await api.createCanvas(owner.session, owner.workspaceId, "Restricted");
    const shared = await api.createCanvas(owner.session, owner.workspaceId, "Shared");
    const board = await api.createCanvas(owner.session, owner.workspaceId, "Board");
    const billing = await api.createNode(owner.session, restricted, { type: "database", name: "Billing DB" });
    const publicApi = await api.createNode(owner.session, shared, { name: "Public API" });
    expect(
      (
        await api.request("PATCH", `/api/entities/${billing}`, owner.session, {
          metadata: { documentation: "Settlement records." },
        })
      ).status,
    ).toBe(200);
    expect((await api.request("PATCH", `/api/canvases/${shared}`, owner.session, { shareMode: "link" })).status).toBe(
      200,
    );
    const addMember = async (canvasId: string, email: string, role: "editor" | "viewer") =>
      expect(
        (await api.request("POST", `/api/canvases/${canvasId}/members`, owner.session, { email, role })).status,
      ).toBe(201);
    await addMember(board, editor.user.email, "editor");
    await addMember(board, viewer.user.email, "viewer");
    const url = `/api/canvases/${board}/placements`;
    const place = (entityId: string) => ({
      placements: [{ entityId, parentEntityId: null, x: 40, y: 40, width: 220, height: 120 }],
    });
    const boardEntityIds = async () =>
      (await api.json<Graph>("GET", `/api/canvases/${board}/graph`, owner.session)).body.placements.map(
        (placement) => placement.entityId,
      );

    // An editor of the board cannot pull in an entity they cannot even read. The response is the same as for a missing
    // entity, so it does not confirm that the entity exists, and nothing is written.
    const refused = await api.json<{ message: string }>("PUT", url, editor.session, place(billing));
    const missing = await api.json<{ message: string }>("PUT", url, editor.session, place(crypto.randomUUID()));
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(missing.body);
    expect(await boardEntityIds()).toEqual([]);
    expect((await api.request("GET", `/api/entities/${billing}`, editor.session)).status).toBe(403);

    // Viewers cannot write placements at all.
    expect((await api.request("PUT", url, viewer.session, place(publicApi))).status).toBe(403);

    // Reading the entity is not enough (#32). A new placement narrows who may edit it, because writes need the editor
    // role on every canvas that shows it, so placing it needs that write access already. An entity readable only
    // through a link share or a viewer role is refused like a missing one.
    const linkOnly = await api.json<{ message: string }>("PUT", url, editor.session, place(publicApi));
    expect(linkOnly.status).toBe(400);
    expect(linkOnly.body).toEqual(missing.body);
    await addMember(restricted, editor.user.email, "viewer");
    const readOnly = await api.json<{ message: string }>("PUT", url, editor.session, place(billing));
    expect(readOnly.status).toBe(400);
    expect(readOnly.body).toEqual(missing.body);
    expect(await boardEntityIds()).toEqual([]);

    // An editor of every canvas that shows the entity may place it, and keeps editing it afterwards.
    await addMember(shared, editor.user.email, "editor");
    expect((await api.json<{ saved: number }>("PUT", url, editor.session, place(publicApi))).body).toEqual({
      saved: 1,
    });
    await addMember(restricted, editor.user.email, "editor");
    expect((await api.json<{ saved: number }>("PUT", url, editor.session, place(billing))).body).toEqual({ saved: 1 });
    expect((await boardEntityIds()).sort()).toEqual([billing, publicApi].sort());
    expect(
      (await api.request("PATCH", `/api/entities/${billing}`, editor.session, { metadata: { documentation: "Kept." } }))
        .status,
    ).toBe(200);

    // Workspace managers and system admins can place any entity in the workspace.
    const third = await api.createCanvas(owner.session, owner.workspaceId, "Third");
    const thirdUrl = `/api/canvases/${third}/placements`;
    expect((await api.json<{ saved: number }>("PUT", thirdUrl, owner.session, place(billing))).body).toEqual({
      saved: 1,
    });
    const admin = await api.register("Placement Admin");
    await api.promoteToAdmin(admin.user.id);
    const ledger = await api.createNode(owner.session, restricted, { type: "database", name: "Ledger DB" });
    expect((await api.json<{ saved: number }>("PUT", thirdUrl, admin.session, place(ledger))).body).toEqual({
      saved: 1,
    });

    // A batch is refused whole when any new entity, including a new parent, is unreadable.
    const secret = await api.createNode(owner.session, restricted, { type: "system", name: "Secret System" });
    await api.request("DELETE", `/api/canvases/${restricted}/members/${editor.user.id}`, owner.session);
    const mixed = await api.json<{ message: string }>("PUT", url, editor.session, {
      placements: [
        { entityId: publicApi, parentEntityId: null, x: 80, y: 80, width: 220, height: 120 },
        { entityId: secret, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 },
      ],
    });
    expect(mixed.status).toBe(400);
    const asParent = await api.json<{ message: string }>("PUT", url, editor.session, {
      placements: [
        { entityId: secret, parentEntityId: null, x: 0, y: 0, width: 600, height: 400 },
        { entityId: publicApi, parentEntityId: secret, x: 20, y: 20, width: 220, height: 120 },
      ],
    });
    expect(asParent.status).toBe(400);
    const graphAfter = (await api.json<Graph>("GET", `/api/canvases/${board}/graph`, owner.session)).body;
    expect(graphAfter.placements.find((placement) => placement.entityId === publicApi)).toMatchObject({
      x: 40,
      y: 40,
      parentEntityId: null,
    });
    expect(graphAfter.placements.some((placement) => placement.entityId === secret)).toBe(false);
  });

  it("places new entities concurrently without exhausting the database pool", async () => {
    const owner = await api.register("Concurrent Placement Owner");
    const source = await api.createCanvas(owner.session, owner.workspaceId, "Source");
    const board = await api.createCanvas(owner.session, owner.workspaceId, "Board");
    const entityIds = await Promise.all(
      Array.from({ length: 12 }, (_, index) => api.createNode(owner.session, source, { name: `Node ${index}` })),
    );
    // Each request holds a pooled connection while it waits for the canvas row lock. The access check must not ask
    // the pool for another connection, or the lock holder waits forever once the pool is exhausted.
    const saves = Promise.all(
      entityIds.map(
        async (entityId) =>
          (
            await api.request("PUT", `/api/canvases/${board}/placements`, owner.session, {
              placements: [{ entityId, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 }],
            })
          ).status,
      ),
    );
    const outcome = await Promise.race([saves, Bun.sleep(10_000).then(() => "timed out")]);
    expect(outcome).toEqual(entityIds.map(() => 200));
  }, 20_000);

  it("rejects placements that reference other workspaces or unplaced parents", async () => {
    const { owner, canvasId, a } = await canvasWithConnection();
    const other = await api.register("Other Workspace Owner");
    const otherCanvas = await api.createCanvas(other.session, other.workspaceId);
    const foreign = await api.createNode(other.session, otherCanvas, { name: "Foreign" });
    const url = `/api/canvases/${canvasId}/placements`;
    const placement = { entityId: a, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 };

    const crossWorkspace = await api.json<{ message: string }>("PUT", url, owner.session, {
      placements: [{ ...placement, parentEntityId: foreign }],
    });
    expect(crossWorkspace.status).toBe(400);
    expect(crossWorkspace.body.message).toBe(
      "Placement entities and parents must belong to the canvas workspace and be visible to you",
    );

    const secondCanvas = await api.createCanvas(owner.session, owner.workspaceId, "Second");
    const unplaced = await api.createNode(owner.session, secondCanvas, { type: "system", name: "Elsewhere" });
    const orphan = await api.json<{ message: string }>("PUT", url, owner.session, {
      placements: [{ ...placement, parentEntityId: unplaced }],
    });
    expect(orphan.status).toBe(400);
    expect(orphan.body.message).toBe("Parent entity must have a placement on the same canvas");

    expect((await api.json<{ saved: number }>("PUT", url, owner.session, { placements: [] })).body).toEqual({
      saved: 0,
    });
    expect((await api.json<{ saved: number }>("PUT", url, owner.session, { placements: [placement] })).body).toEqual({
      saved: 1,
    });
  });
});
