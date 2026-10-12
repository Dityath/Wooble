import { beforeEach, describe, expect, it } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { canvasEvents, connections, db, entities, type CanvasEventAction } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { type DeleteScope, describeUpdate, undoRegistry } from "../src/modules/canvas/undo";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Entity = { id: string; type: string; name: string; description: string | null; metadata: Record<string, unknown> };
type Connection = { id: string; type: string; label: string; metadata: Record<string, unknown> };
type Graph = { entities: Entity[]; connections: Connection[]; placements: Array<{ entityId: string; x: number }> };
type UndoBody = {
  undone?: boolean;
  action?: string;
  error?: string;
  skipped?: Array<{ action: string; targetName: string | null; reason: string }>;
};

/** An owner and an invited canvas editor sharing a canvas with a service, a database, and a connector. */
async function sharedCanvas() {
  const owner = await api.register("Scope Owner");
  const editor = await api.register("Scope Editor");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Payments");
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor");
  expect((await api.request("POST", `/api/invitations/${token}/accept`, editor.session)).status).toBe(200);
  const service = await api.createNode(owner.session, canvasId, { name: "Payments API" });
  const database = await api.createNode(owner.session, canvasId, { type: "database", name: "Ledger DB", x: 500 });
  const connectionId = await api.connect(owner.session, canvasId, service, database);
  const graph = async () => (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
  const entity = async (id = service) => (await graph()).entities.find((item) => item.id === id) as Entity;
  const connection = async () => (await graph()).connections[0];
  const undo = async (session = owner.session) => api.json<UndoBody>("POST", `/api/canvases/${canvasId}/undo`, session);
  const patchEntity = async (session: string, payload: unknown, id = service) =>
    expect((await api.request("PATCH", `/api/entities/${id}`, session, payload)).status).toBe(200);
  const patchConnection = async (session: string, payload: unknown) =>
    expect((await api.request("PATCH", `/api/connections/${connectionId}`, session, payload)).status).toBe(200);
  return {
    owner,
    editor,
    canvasId,
    service,
    database,
    connectionId,
    graph,
    entity,
    connection,
    undo,
    patchEntity,
    patchConnection,
  };
}

async function latestEvent(canvasId: string, action: CanvasEventAction) {
  const [row] = await db
    .select()
    .from(canvasEvents)
    .where(and(eq(canvasEvents.canvasId, canvasId), eq(canvasEvents.action, action)))
    .orderBy(desc(canvasEvents.createdAt))
    .limit(1);
  return row;
}

/** Inserts an `entity.updated` row in the format builds before field-scoped undo wrote. */
async function insertLegacyEntityUpdate(
  canvasId: string,
  actorUserId: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await db.insert(canvasEvents).values({
    canvasId,
    actorUserId,
    actorName: "Scope Owner",
    action: "entity.updated",
    targetType: "entity",
    targetId: entityId,
    targetName: "Legacy edit",
    metadata,
  });
}

describe("update events describe only what changed", () => {
  it("stores previous values of the changed fields and metadata keys", () => {
    const before = {
      type: "service",
      name: "Payments API",
      description: null,
      metadata: { language: "Go", documentation: "Long private notes", interfaces: ["REST"] },
    };
    const after = {
      ...before,
      name: "Payments Service",
      metadata: {
        language: "Go",
        documentation: "Long private notes",
        interfaces: ["REST", "gRPC"],
        status: "planned",
      },
    };
    expect(describeUpdate("entity", before, after)).toEqual({
      fields: ["name", "metadata"],
      metadataKeys: ["interfaces", "status"],
      previous: { name: "Payments API", metadata: { interfaces: ["REST"], status: null } },
    });
    expect(describeUpdate("entity", before, { ...before, metadata: { ...before.metadata } })).toBeNull();
    expect(
      describeUpdate(
        "connection",
        { type: "rest", label: "", description: "Old", metadata: { contractBody: "openapi: 3.1.0" } },
        { type: "grpc", label: "", description: null, metadata: {} },
      ),
    ).toEqual({
      fields: ["type", "description", "metadata"],
      metadataKeys: ["contractBody"],
      previous: { type: "rest", description: "Old", metadata: { contractBody: "openapi: 3.1.0" } },
    });
  });

  it("records the scoped payload from PATCH and no event for a save that changed nothing", async () => {
    const { owner, canvasId, service, patchEntity } = await sharedCanvas();
    await patchEntity(owner.session, { metadata: { documentation: "Settles card payments." } });
    await patchEntity(owner.session, {
      name: "Payments Service",
      metadata: { documentation: "Settles card payments." },
    });
    const rename = await latestEvent(canvasId, "entity.updated");
    expect(rename.metadata).toEqual({ fields: ["name"], metadataKeys: [], previous: { name: "Payments API" } });

    await patchEntity(owner.session, { name: "Payments Service" });
    const events = await db
      .select({ id: canvasEvents.id })
      .from(canvasEvents)
      .where(and(eq(canvasEvents.canvasId, canvasId), eq(canvasEvents.targetId, service)));
    // created, documentation edit, rename; the unchanged save adds nothing.
    expect(events).toHaveLength(3);
  });
});

describe("undo of an update restores only what that event changed", () => {
  it("reverts a rename without touching documentation a collaborator saved later", async () => {
    const { owner, editor, patchEntity, entity, undo } = await sharedCanvas();
    await patchEntity(owner.session, { name: "Payments Service" });
    await patchEntity(editor.session, { metadata: { documentation: "Retries are idempotent." } });

    expect((await undo()).body).toEqual({ undone: true, action: "entity.updated", skipped: [] });
    expect(await entity()).toMatchObject({
      name: "Payments API",
      metadata: { documentation: "Retries are idempotent." },
    });
  });

  it("restores only the actor's metadata keys and skips keys a collaborator changed since", async () => {
    const { owner, editor, patchEntity, entity, undo } = await sharedCanvas();
    await patchEntity(owner.session, { metadata: { language: "Go" } });
    await patchEntity(owner.session, { metadata: { language: "Rust", framework: "Axum" } });
    await patchEntity(editor.session, { metadata: { status: "planned" } });

    // The newest owner edit changed language and added framework; status is the collaborator's.
    expect((await undo()).body).toMatchObject({ undone: true, action: "entity.updated" });
    expect((await entity()).metadata).toEqual({ language: "Go", status: "planned" });

    // A collaborator change to the same key supersedes the owner's older edit.
    await patchEntity(editor.session, { metadata: { language: "Kotlin" } });
    const blocked = await undo();
    expect(blocked.body.skipped).toContainEqual({
      action: "entity.updated",
      targetName: "Payments API",
      reason: "conflict",
    });
    expect((await entity()).metadata).toEqual({ language: "Kotlin", status: "planned" });
  });

  it("reverts a connection label without reverting a newer contract body", async () => {
    const { owner, editor, patchConnection, connection, undo } = await sharedCanvas();
    await patchConnection(owner.session, { label: "Posts ledger entries" });
    await patchConnection(editor.session, { metadata: { contractBody: "openapi: 3.1.0\ninfo:\n  title: Ledger" } });

    expect((await undo()).body).toEqual({ undone: true, action: "connection.updated", skipped: [] });
    expect(await connection()).toMatchObject({
      label: "",
      metadata: { contractBody: "openapi: 3.1.0\ninfo:\n  title: Ledger" },
    });
  });

  it("keeps a collaborator's reroute when undoing a label change on the same connector", async () => {
    const { owner, editor, canvasId, connectionId, patchConnection, connection, undo } = await sharedCanvas();
    await patchConnection(owner.session, { label: "Posts ledger entries" });
    const rerouted = await api.request(
      "PUT",
      `/api/canvases/${canvasId}/connections/${connectionId}/bend`,
      editor.session,
      { bend: { x: 240, y: 80 } },
    );
    expect(rerouted.status).toBe(200);

    expect((await undo()).body).toEqual({ undone: true, action: "connection.updated", skipped: [] });
    expect(await connection()).toMatchObject({ label: "", bend: { x: 240, y: 80 } });
  });
});

describe("undo of legacy update events", () => {
  it("restores only the listed top-level fields, never the stored metadata", async () => {
    const { owner, canvasId, service, entity, undo } = await sharedCanvas();
    await db
      .update(entities)
      .set({ name: "Payments Service", metadata: { documentation: "Current notes" } })
      .where(eq(entities.id, service));
    await insertLegacyEntityUpdate(canvasId, owner.user.id, service, {
      fields: ["name"],
      previous: { type: "service", name: "Payments API", description: null, metadata: { documentation: "Old notes" } },
    });

    expect((await undo()).body).toMatchObject({ undone: true, action: "entity.updated" });
    expect(await entity()).toMatchObject({ name: "Payments API", metadata: { documentation: "Current notes" } });
  });

  it("restores the metadata keys that differ from the stored snapshot", async () => {
    const { owner, canvasId, service, entity, undo } = await sharedCanvas();
    await db
      .update(entities)
      .set({ metadata: { language: "Rust", framework: "Axum", documentation: "Same notes" } })
      .where(eq(entities.id, service));
    await insertLegacyEntityUpdate(canvasId, owner.user.id, service, {
      fields: ["metadata"],
      previous: {
        type: "service",
        name: "Payments API",
        description: null,
        metadata: { language: "Go", documentation: "Same notes" },
      },
    });

    expect((await undo()).body).toMatchObject({ undone: true, action: "entity.updated" });
    // framework was added by the event and goes; documentation never changed.
    const restored = await entity();
    expect(restored.name).toBe("Payments API");
    expect(restored.metadata).toEqual({ language: "Go", documentation: "Same notes" });
  });

  it("treats a legacy metadata edit as superseded by any later collaborator metadata change", async () => {
    const { owner, editor, canvasId, service, patchEntity, entity, undo } = await sharedCanvas();
    await db
      .update(entities)
      .set({ metadata: { language: "Rust" } })
      .where(eq(entities.id, service));
    await insertLegacyEntityUpdate(canvasId, owner.user.id, service, {
      fields: ["metadata"],
      previous: { type: "service", name: "Payments API", description: null, metadata: { language: "Go" } },
    });
    await patchEntity(editor.session, { metadata: { documentation: "Collaborator notes" } });

    const result = await undo();
    expect(result.body.skipped).toContainEqual({
      action: "entity.updated",
      targetName: "Legacy edit",
      reason: "conflict",
    });
    expect((await entity()).metadata).toEqual({ language: "Rust", documentation: "Collaborator notes" });
  });

  it("restores every top-level field for rows without a field list", async () => {
    const { owner, canvasId, service, entity, undo } = await sharedCanvas();
    await db.update(entities).set({ name: "Payments Service", description: "Edited" }).where(eq(entities.id, service));
    await insertLegacyEntityUpdate(canvasId, owner.user.id, service, {
      previous: { type: "service", name: "Payments API", description: null, metadata: {} },
    });

    expect((await undo()).body).toMatchObject({ undone: true, action: "entity.updated" });
    expect(await entity()).toMatchObject({ name: "Payments API", description: null });
  });

  it("restores a legacy connection edit from its full snapshot", async () => {
    const { owner, canvasId, connectionId, connection, undo } = await sharedCanvas();
    await db
      .update(connections)
      .set({ label: "Posts entries", metadata: { contract: "ledger.v2", direction: "two-way" } })
      .where(eq(connections.id, connectionId));
    await db.insert(canvasEvents).values({
      canvasId,
      actorUserId: owner.user.id,
      actorName: "Scope Owner",
      action: "connection.updated",
      targetType: "connection",
      targetId: connectionId,
      targetName: "Posts entries",
      metadata: {
        fields: ["metadata"],
        previous: { type: "rest", label: "", description: null, metadata: { contract: "ledger.v1" } },
      },
    });

    expect((await undo()).body).toMatchObject({ undone: true, action: "connection.updated" });
    const restored = await connection();
    expect(restored.label).toBe("Posts entries");
    expect(restored.metadata).toEqual({ contract: "ledger.v1" });
  });
});

describe("undo registry", () => {
  it("never restores or conflicts on metadata keys managed elsewhere", async () => {
    const unregister = undoRegistry.registerManagedMetadataKey("entity", "documentation");
    try {
      const { owner, editor, patchEntity, entity, undo } = await sharedCanvas();
      await patchEntity(owner.session, { name: "Payments Service", metadata: { documentation: "Draft" } });
      await patchEntity(editor.session, { metadata: { documentation: "Published" } });

      expect((await undo()).body).toEqual({ undone: true, action: "entity.updated", skipped: [] });
      expect(await entity()).toMatchObject({ name: "Payments API", metadata: { documentation: "Published" } });

      // An edit of only a managed key has nothing canvas undo may restore.
      await patchEntity(owner.session, { metadata: { documentation: "Owner draft" } });
      const result = await undo();
      expect(result.body.skipped?.[0]).toEqual({
        action: "entity.updated",
        targetName: "Payments API",
        reason: "no-op",
      });
      expect((await entity()).metadata).toEqual({ documentation: "Owner draft" });
    } finally {
      unregister();
    }
  });

  it("never undoes an irreversible action and keeps older events on the same object", async () => {
    const unregister = undoRegistry.registerIrreversibleAction("placement.updated");
    try {
      const { owner, canvasId, service, database, graph, undo } = await sharedCanvas();
      const moved = await api.request("PUT", `/api/canvases/${canvasId}/placements`, owner.session, {
        placements: [{ entityId: database, parentEntityId: null, x: 900, y: 0, width: 220, height: 120 }],
      });
      expect(moved.status).toBe(200);

      // The move stays; the connector (no overlap) is undone; the database's
      // creation sits behind the move and is skipped as a conflict.
      expect((await undo()).body).toEqual({ undone: true, action: "connection.created", skipped: [] });
      const next = await undo();
      expect(next.body).toEqual({
        undone: true,
        action: "entity.created",
        skipped: [{ action: "entity.created", targetName: "Ledger DB", reason: "conflict" }],
      });
      const after = await graph();
      expect(after.entities.map((item) => item.id)).toEqual([database]);
      expect(after.placements.find((item) => item.entityId === database)?.x).toBe(900);
      expect(after.entities.some((item) => item.id === service)).toBe(false);
    } finally {
      unregister();
    }
  });

  it("snapshots and restores extra rows through delete hooks", async () => {
    const restored: Array<{ target: string; scope: DeleteScope; snapshot: unknown }> = [];
    const hook = (target: string) => ({
      capture: async (_tx: unknown, scope: DeleteScope) => ({ probe: `${target}:${scope.entityIds.length}` }),
      restore: async (_tx: unknown, scope: DeleteScope, snapshot: unknown) => {
        restored.push({ target, scope, snapshot });
      },
    });
    const unregisterEntity = undoRegistry.registerDeleteHook("entity", "probe", hook("entity"));
    const unregisterConnection = undoRegistry.registerDeleteHook("connection", "probe", hook("connection"));
    try {
      expect(() => undoRegistry.registerDeleteHook("entity", "probe", hook("entity"))).toThrow();
      const { owner, canvasId, service, connectionId, undo } = await sharedCanvas();
      const url = `/api/canvases/${canvasId}`;
      expect((await api.request("DELETE", `${url}/connections/${connectionId}`, owner.session)).status).toBe(200);
      expect((await undo()).body).toMatchObject({ undone: true, action: "connection.deleted" });
      expect((await api.request("DELETE", `${url}/entities/${service}`, owner.session)).status).toBe(200);
      expect((await undo()).body).toMatchObject({ undone: true, action: "entity.deleted" });

      expect(restored).toEqual([
        {
          target: "connection",
          scope: { canvasId, entityIds: [], connectionIds: [connectionId] },
          snapshot: { probe: "connection:0" },
        },
        {
          target: "entity",
          scope: { canvasId, entityIds: [service], connectionIds: [connectionId] },
          snapshot: { probe: "entity:1" },
        },
      ]);
    } finally {
      unregisterEntity();
      unregisterConnection();
    }
  });
});
