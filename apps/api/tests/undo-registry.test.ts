import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { EntityMetadata } from "@wooble/domain";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { canvasEvents, db, entities, users } from "@wooble/db";
import {
  captureDeleteHooks,
  registerDeleteUndoHook,
  registerExternalMetadataKey,
  registerNonReversibleAction,
  type DeleteUndoTarget,
} from "../src/modules/canvas/undo-registry";

const app = createApp();
const email = `undo-reg-${crypto.randomUUID().slice(0, 8)}@example.test`;
const password = "WoobleTestPassword-2026";
let cookie = "";

type ApiResponse = Response & { json(): Promise<unknown> };

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

async function postUndo(canvasId: string) {
  const response = await request("POST", `/api/canvases/${canvasId}/undo`, { cookie });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function userId(address: string): Promise<string> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, address)).limit(1);
  if (!row) throw new Error("user not found");
  return row.id;
}

beforeAll(async () => {
  resetLoginAttempts();
  const registered = await request(
    "POST",
    "/api/auth/register",
    {},
    { name: "Registry Tester", email, password, confirmPassword: password },
  );
  expect(registered.status).toBe(201);
  const login = await request("POST", "/api/auth/login", {}, { email, password });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
});

afterAll(async () => {
  if (app.server) await app.stop(true);
});

async function world() {
  const peerEmail = `undo-reg-peer-${crypto.randomUUID().slice(0, 8)}@example.test`;
  resetLoginAttempts();
  const peer = await request(
    "POST",
    "/api/auth/register",
    {},
    { name: "Registry Peer", email: peerEmail, password, confirmPassword: password },
  );
  expect(peer.status).toBe(201);
  const workspace = (await (
    await request("POST", "/api/workspaces", { cookie }, { name: "Reg WS", description: "" })
  ).json()) as { id: string };
  const canvas = (await (
    await request("POST", "/api/canvases", { cookie }, { workspaceId: workspace.id, name: "Reg", description: "" })
  ).json()) as { id: string };
  const createEntity = async (type: string, name: string, x: number) =>
    (
      (await (
        await request(
          "POST",
          `/api/canvases/${canvas.id}/entities`,
          { cookie },
          { type, name, x, y: 20, parentEntityId: null },
        )
      ).json()) as { id: string }
    ).id;
  const first = await createEntity("service", "Billing", 10);
  const second = await createEntity("database", "Main DB", 400);
  await db.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.canvasId, canvas.id));
  return { canvasId: canvas.id, first, second, ownerId: await userId(email), peerId: await userId(peerEmail) };
}

async function record(
  w: Awaited<ReturnType<typeof world>>,
  actor: "owner" | "peer",
  targetId: string,
  metadata: Record<string, unknown>,
  action: "entity.updated" | "canvas.auto_neat" = "entity.updated",
) {
  const [row] = await db
    .insert(canvasEvents)
    .values({
      canvasId: w.canvasId,
      actorUserId: actor === "owner" ? w.ownerId : w.peerId,
      actorName: actor,
      action,
      targetType: "entity",
      targetId,
      targetName: "target",
      metadata,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

async function entityRow(id: string) {
  const [row] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  if (!row) throw new Error("entity missing");
  return row;
}

describe("Undo registry", () => {
  it("walks past non-reversible actions without marking them undone", async () => {
    const w = await world();
    await db.update(entities).set({ name: "A2" }).where(eq(entities.id, w.second));
    const older = await record(w, "owner", w.second, {
      version: 2,
      fields: ["name"],
      previous: { name: "Main DB" },
      previousMetadata: {},
    });
    await db.update(entities).set({ name: "B2" }).where(eq(entities.id, w.first));
    const newer = await record(w, "owner", w.first, {
      version: 2,
      fields: ["name"],
      previous: { name: "Billing" },
      previousMetadata: {},
    });
    const unregister = registerNonReversibleAction("entity.updated");
    try {
      // Both are entity.updated, so both are non-reversible: nothing to undo.
      expect(await postUndo(w.canvasId)).toEqual({ status: 200, body: { undone: false } });
    } finally {
      unregister();
    }
    const rows = await db.select().from(canvasEvents).where(eq(canvasEvents.canvasId, w.canvasId));
    expect(rows.find((row) => row.id === newer.id)?.undoneAt).toBeNull();
    expect(rows.find((row) => row.id === older.id)?.undoneAt).toBeNull();
    expect((await entityRow(w.first)).name).toBe("B2");

    // Once unregistered the newest event is a candidate again.
    expect((await postUndo(w.canvasId)).body).toMatchObject({ undone: true, action: "entity.updated" });
    expect((await entityRow(w.first)).name).toBe("Billing");
  });

  it("walks past a newer non-reversible event and undoes the older reversible one", async () => {
    const w = await world();
    await db.update(entities).set({ name: "Renamed DB" }).where(eq(entities.id, w.second));
    const older = await record(w, "owner", w.second, {
      version: 2,
      fields: ["name"],
      previous: { name: "Main DB" },
      previousMetadata: {},
    });
    const newer = await record(
      w,
      "owner",
      w.first,
      { previous: { placements: [], connections: [] } },
      "canvas.auto_neat",
    );
    const unregister = registerNonReversibleAction("canvas.auto_neat");
    try {
      expect((await postUndo(w.canvasId)).body).toMatchObject({ undone: true, action: "entity.updated" });
    } finally {
      unregister();
    }
    const rows = await db.select().from(canvasEvents).where(eq(canvasEvents.canvasId, w.canvasId));
    expect(rows.find((row) => row.id === older.id)?.undoneAt).not.toBeNull();
    expect(rows.find((row) => row.id === newer.id)?.undoneAt).toBeNull();
    expect((await entityRow(w.second)).name).toBe("Main DB");
  });

  it("never restores or conflicts on externally managed metadata keys", async () => {
    const unregister = registerExternalMetadataKey("comments");
    try {
      const w = await world();
      await db
        .update(entities)
        .set({ name: "Renamed", metadata: { comments: ["c1"], language: "now" } as EntityMetadata })
        .where(eq(entities.id, w.first));
      await record(w, "owner", w.first, {
        version: 2,
        fields: ["name", "metadata"],
        previous: { name: "Billing" },
        previousMetadata: { comments: { present: false }, language: { present: false } },
      });
      // The peer touched only the external key later: not a conflict.
      await record(w, "peer", w.first, {
        version: 2,
        fields: ["metadata"],
        previous: {},
        previousMetadata: { comments: { present: false } },
      });
      expect((await postUndo(w.canvasId)).body).toEqual({ undone: true, action: "entity.updated", skipped: [] });
      const row = await entityRow(w.first);
      expect(row.name).toBe("Billing");
      expect(row.metadata as Record<string, unknown>).toEqual({ comments: ["c1"] });
    } finally {
      unregister();
    }
  });

  it("captures delete hook data and hands it back to restore on undo", async () => {
    const w = await world();
    const restores: Array<{ target: DeleteUndoTarget; data: unknown }> = [];
    const unregister = registerDeleteUndoHook({
      name: "fake-comments",
      async snapshot(_tx, target) {
        return { count: target.ids.length, note: "kept" };
      },
      async restore(_tx, target, data) {
        restores.push({ target, data });
      },
    });
    try {
      const target: DeleteUndoTarget = { kind: "entity", ids: [w.second] };
      const captured = await db.transaction((tx) => captureDeleteHooks(tx, target));
      expect(captured).toEqual({ "fake-comments": { count: 1, note: "kept" } });

      const deleted = await request("DELETE", `/api/canvases/${w.canvasId}/entities/${w.second}`, { cookie });
      expect(deleted.status).toBe(200);
      const [event] = await db
        .select()
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, w.canvasId), eq(canvasEvents.action, "entity.deleted")));
      if (!event) throw new Error("delete event missing");
      await db
        .update(canvasEvents)
        .set({ metadata: { ...event.metadata, hooks: { ...captured, "unknown-hook": { ignored: true } } } })
        .where(eq(canvasEvents.id, event.id));

      expect((await postUndo(w.canvasId)).body).toMatchObject({ undone: true, action: "entity.deleted" });
      expect(restores).toEqual([{ target: { kind: "entity", ids: [w.second] }, data: { count: 1, note: "kept" } }]);
      expect((await entityRow(w.second)).name).toBe("Main DB");
    } finally {
      unregister();
    }
    // With no hook registered nothing is captured.
    expect(await db.transaction((tx) => captureDeleteHooks(tx, { kind: "entity", ids: [w.first] }))).toEqual({});
  });

  it("stores delete hook snapshots on the real delete events and restores them on undo", async () => {
    const w = await world();
    const restores: Array<{ target: DeleteUndoTarget; data: unknown }> = [];
    const unregister = registerDeleteUndoHook({
      name: "fake-comments",
      async snapshot(_tx, target) {
        return { kind: target.kind, count: target.ids.length };
      },
      async restore(_tx, target, data) {
        restores.push({ target, data });
      },
    });
    try {
      const connectionResponse = await request(
        "POST",
        `/api/canvases/${w.canvasId}/connections`,
        { cookie },
        { sourceEntityId: w.first, targetEntityId: w.second, type: "rest" },
      );
      expect(connectionResponse.status).toBe(201);
      const { id: connectionId } = (await connectionResponse.json()) as { id: string };
      await db.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.canvasId, w.canvasId));

      expect(
        (await request("DELETE", `/api/canvases/${w.canvasId}/connections/${connectionId}`, { cookie })).status,
      ).toBe(200);
      const [connectionEvent] = await db
        .select()
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, w.canvasId), eq(canvasEvents.action, "connection.deleted")));
      expect(((connectionEvent?.metadata ?? {}) as Record<string, unknown>).hooks).toEqual({
        "fake-comments": { kind: "connection", count: 1 },
      });
      expect((await postUndo(w.canvasId)).body).toMatchObject({ undone: true, action: "connection.deleted" });
      expect(restores.at(-1)).toEqual({
        target: { kind: "connection", ids: [connectionId] },
        data: { kind: "connection", count: 1 },
      });

      expect((await request("DELETE", `/api/canvases/${w.canvasId}/entities/${w.second}`, { cookie })).status).toBe(
        200,
      );
      const [entityEvent] = await db
        .select()
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, w.canvasId), eq(canvasEvents.action, "entity.deleted")));
      expect(((entityEvent?.metadata ?? {}) as Record<string, unknown>).hooks).toEqual({
        "fake-comments": { kind: "entity", count: 1 },
      });
      restores.length = 0;
      expect((await postUndo(w.canvasId)).body).toMatchObject({ undone: true, action: "entity.deleted" });
      expect(restores).toEqual([{ target: { kind: "entity", ids: [w.second] }, data: { kind: "entity", count: 1 } }]);
      expect((await entityRow(w.second)).name).toBe("Main DB");
    } finally {
      unregister();
    }
  });

  it("rolls the whole undo back when a restore hook throws", async () => {
    const w = await world();
    const unregister = registerDeleteUndoHook({
      name: "fake-failing",
      async snapshot() {
        return { saved: true };
      },
      async restore() {
        throw new Error("restore failed");
      },
    });
    try {
      expect((await request("DELETE", `/api/canvases/${w.canvasId}/entities/${w.second}`, { cookie })).status).toBe(
        200,
      );
      const undone = await postUndo(w.canvasId);
      expect(undone.status).toBeGreaterThanOrEqual(500);
      expect(await db.select().from(entities).where(eq(entities.id, w.second))).toHaveLength(0);
      const [event] = await db
        .select()
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, w.canvasId), eq(canvasEvents.action, "entity.deleted")));
      expect(event?.undoneAt).toBeNull();
      const undoEvents = await db
        .select()
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, w.canvasId), eq(canvasEvents.action, "canvas.undo")));
      expect(undoEvents).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});
