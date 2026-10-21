import { beforeEach, describe, expect, it } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { canvases, canvasEvents, db, entities, pool } from "@wooble/db";
import { createApp } from "../src/app";
import { CanvasLockContention, withCanvasLocks } from "../src/modules/canvas/activity";
import { applyNextUndo, retryOnLockConflict } from "../src/modules/canvas/undo";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Owner = Awaited<ReturnType<typeof api.register>>;
type Graph = {
  entities: Array<{ id: string; name: string; metadata: Record<string, unknown> }>;
  connections: Array<{ id: string; label: string; metadata: Record<string, unknown> }>;
};
type UndoResult = { undone: boolean; action?: string; skipped?: Array<{ reason: string }> };

async function setup() {
  const owner = await api.register("Event Owner");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
  const service = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const database = await api.createNode(owner.session, canvasId, { type: "database", name: "Orders DB", x: 500 });
  const connectionId = await api.connect(owner.session, canvasId, service, database);
  return { owner, canvasId, service, database, connectionId };
}

async function joinAsEditor(owner: Owner, canvasId: string) {
  const guest = await api.register("Event Editor");
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor");
  expect((await api.json("POST", `/api/invitations/${token}/accept`, guest.session)).status).toBe(200);
  return guest;
}

async function joinExisting(owner: Owner, canvasId: string, guest: Owner, role: "editor" | "viewer" = "editor") {
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
  expect((await api.json("POST", `/api/invitations/${token}/accept`, guest.session)).status).toBe(200);
}

async function eventsFor(canvasId: string, action?: string) {
  const rows = await db
    .select()
    .from(canvasEvents)
    .where(eq(canvasEvents.canvasId, canvasId))
    .orderBy(asc(canvasEvents.seq));
  return action ? rows.filter((row) => row.action === action) : rows;
}

async function graph(session: string, canvasId: string) {
  return (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, session)).body;
}

/** A trigger that makes every event insert for one canvas fail. Dropped by the returned function. */
async function failEventsFor(canvasId: string) {
  const name = `test_fail_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await pool.query(
    `create function ${name}() returns trigger language plpgsql as $$ begin
       if new.canvas_id = '${canvasId}'::uuid then raise exception 'event insert refused for test'; end if;
       return new; end $$`,
  );
  await pool.query(`create trigger ${name} before insert on canvas_events for each row execute function ${name}()`);
  return async () => {
    await pool.query(`drop trigger if exists ${name} on canvas_events`);
    await pool.query(`drop function if exists ${name}()`);
  };
}

async function placeOnCanvas(session: string, canvasId: string, entityId: string) {
  const { status } = await api.json("PUT", `/api/canvases/${canvasId}/placements`, session, {
    placements: [{ entityId, parentEntityId: null, x: 10, y: 10, width: 220, height: 120 }],
  });
  expect(status).toBe(200);
}

describe("canvas events are recorded in the change's transaction", () => {
  it("rolls back an entity update when its event cannot be recorded", async () => {
    const { owner, canvasId, service } = await setup();
    const drop = await failEventsFor(canvasId);
    try {
      const response = await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Renamed" });
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await drop();
    }
    expect((await graph(owner.session, canvasId)).entities.find((e) => e.id === service)?.name).toBe("Orders API");
    expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(0);
  });

  it("rolls back a connection update when its event cannot be recorded", async () => {
    const { owner, canvasId, connectionId } = await setup();
    const drop = await failEventsFor(canvasId);
    try {
      const response = await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, { label: "x" });
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await drop();
    }
    expect((await graph(owner.session, canvasId)).connections[0].label).toBe("");
    expect(await eventsFor(canvasId, "connection.updated")).toHaveLength(0);
  });

  it("rolls back a canvas update when its event cannot be recorded", async () => {
    const { owner, canvasId } = await setup();
    const drop = await failEventsFor(canvasId);
    try {
      const response = await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { name: "Renamed" });
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await drop();
    }
    const canvas = await api.json<{ name: string }>("GET", `/api/canvases/${canvasId}`, owner.session);
    expect(canvas.body.name).toBe("Checkout flow");
    expect(await eventsFor(canvasId, "canvas.updated")).toHaveLength(0);
  });

  it("rolls back every canvas's event when one canvas of a shared entity fails", async () => {
    for (const failing of ["first", "second"] as const) {
      const { owner, canvasId, service } = await setup();
      const otherId = await api.createCanvas(owner.session, owner.workspaceId, "Second");
      await placeOnCanvas(owner.session, otherId, service);
      const drop = await failEventsFor(failing === "first" ? canvasId : otherId);
      try {
        const response = await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Shared" });
        expect(response.status).toBeGreaterThanOrEqual(500);
      } finally {
        await drop();
      }
      const [row] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, service));
      expect(row.name).toBe("Orders API");
      expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(0);
      expect(await eventsFor(otherId, "entity.updated")).toHaveLength(0);

      // Without the failure, both canvases get exactly one event.
      expect((await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Shared" })).status).toBe(
        200,
      );
      expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(1);
      expect(await eventsFor(otherId, "entity.updated")).toHaveLength(1);
    }
  });
});

describe("update events carry exact version 2 undo data", () => {
  it("stores previous values only for named fields and distinguishes absent metadata keys", async () => {
    const { owner, canvasId, service, connectionId } = await setup();
    await api.request("PATCH", `/api/entities/${service}`, owner.session, { metadata: { language: "Go" } });
    await api.request("PATCH", `/api/entities/${service}`, owner.session, {
      name: "Orders v2",
      metadata: { language: null, status: "planned", documentation: "" },
    });
    const [first, second] = await eventsFor(canvasId, "entity.updated");
    expect(first.metadata).toEqual({
      version: 2,
      fields: ["metadata"],
      previous: {},
      previousMetadata: { language: { present: false } },
    });
    expect(second.metadata).toEqual({
      version: 2,
      fields: ["name", "metadata"],
      previous: { name: "Orders API" },
      previousMetadata: {
        language: { present: true, value: "Go" },
        status: { present: false },
      },
      documentationUndo: { present: false },
    });

    await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, {
      type: "grpc",
      description: "Nightly",
      metadata: { contract: "orders.v1" },
    });
    const [connectionEvent] = await eventsFor(canvasId, "connection.updated");
    expect(connectionEvent.metadata).toEqual({
      version: 2,
      fields: ["type", "description", "metadata"],
      previous: { type: "rest", description: null },
      previousMetadata: { contract: { present: false } },
    });
  });

  it("records canvas.updated previous values for body fields only", async () => {
    const { owner, canvasId } = await setup();
    await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { name: "Renamed" });
    const [event] = await eventsFor(canvasId, "canvas.updated");
    expect(event.metadata).toEqual({ fields: ["name"], previous: { name: "Checkout flow" } });
  });
});

describe("undo after a collaborator's edit", () => {
  it("restores the renamed field and keeps the collaborator's metadata", async () => {
    const { owner, canvasId, service, database, connectionId } = await setup();
    const editor = await joinAsEditor(owner, canvasId);
    const undo = async () => (await api.json<UndoResult>("POST", `/api/canvases/${canvasId}/undo`, owner.session)).body;

    // Entity with documentation.
    await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Renamed API" });
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, editor.session, { metadata: { documentation: "Docs" } }))
        .status,
    ).toBe(200);
    expect(await undo()).toMatchObject({ undone: true, action: "entity.updated" });
    let current = await graph(owner.session, canvasId);
    expect(current.entities.find((e) => e.id === service)).toMatchObject({
      name: "Orders API",
      metadata: { documentation: "Docs" },
    });

    // Connection with contractBody.
    await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, { label: "Loads orders" });
    expect(
      (
        await api.request("PATCH", `/api/connections/${connectionId}`, editor.session, {
          metadata: { contractBody: "openapi: 3" },
        })
      ).status,
    ).toBe(200);
    expect(await undo()).toMatchObject({ undone: true, action: "connection.updated" });
    current = await graph(owner.session, canvasId);
    expect(current.connections.find((c) => c.id === connectionId)).toMatchObject({
      label: "",
      metadata: { contractBody: "openapi: 3" },
    });

    // Database entity with schemaSql.
    await api.request("PATCH", `/api/entities/${database}`, owner.session, { name: "Ledger DB" });
    expect(
      (await api.request("PATCH", `/api/entities/${database}`, editor.session, { metadata: { schemaSql: "select 1" } }))
        .status,
    ).toBe(200);
    expect(await undo()).toMatchObject({ undone: true, action: "entity.updated" });
    current = await graph(owner.session, canvasId);
    expect(current.entities.find((e) => e.id === database)).toMatchObject({
      name: "Orders DB",
      metadata: { schemaSql: "select 1" },
    });
  });
});

/** The part of a pooled `pg` client these tests use (`pg` types are not resolvable from this package). */
interface PoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

async function connect(): Promise<PoolClient> {
  return (await pool.connect()) as unknown as PoolClient;
}

/**
 * Waits (bounded polling; assertions never depend on elapsed time) until `count` backends of this database are
 * blocked behind `blockerPid`, directly or through the waiters queued ahead of them. Postgres reports a queued
 * row-lock waiter as blocked by the waiter ahead of it, so the blocker's waiters are followed transitively. Only
 * backends of the current test database that depend on this one blocker are counted.
 */
async function waitForBlocked(blockerPid: number, count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await pool.query<{ n: string }>(
      `with recursive waiting(pid) as (
         select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and pg_blocking_pids(pid) @> array[$1::int]
         union
         select a.pid from pg_stat_activity a join waiting w on pg_blocking_pids(a.pid) @> array[w.pid]
          where a.datname = current_database()
       )
       select count(*) as n from waiting`,
      [blockerPid],
    );
    if (Number(rows[0].n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} backend(s) blocked behind pid ${blockerPid}`);
}

async function lockCanvas(canvasId: string) {
  const blocker: PoolClient = await connect();
  await blocker.query("begin");
  await blocker.query("select id from canvases where id = $1 for update", [canvasId]);
  const { rows } = await blocker.query("select pg_backend_pid() as pid");
  return { blocker, pid: Number(rows[0].pid) };
}

async function release(blocker: PoolClient) {
  try {
    await blocker.query("commit");
  } finally {
    blocker.release();
  }
}

describe("lock order and event order", () => {
  it("takes the canvas lock before the entity lock", async () => {
    const { owner, canvasId, service } = await setup();
    const { blocker, pid } = await lockCanvas(canvasId);
    let patch: Promise<Response> | undefined;
    try {
      patch = api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Ordered" });
      await waitForBlocked(pid, 1);
      // The PATCH is waiting on the canvas row, so it must not hold the entity row yet.
      const probe: PoolClient = await connect();
      try {
        await probe.query("begin");
        const locked = await probe.query("select id, name from entities where id = $1 for update nowait", [service]);
        expect(locked.rows).toHaveLength(1);
        // Nothing of the update is committed yet either: the change and its event land together, after the canvas lock.
        expect(locked.rows[0].name).toBe("Orders API");
        await probe.query("rollback");
      } finally {
        probe.release();
      }
    } finally {
      await release(blocker);
    }
    expect((await patch)?.status).toBe(200);
    expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(1);
  });

  /** The owner renames the service; the editor's concurrent metadata edit and the owner's undo then interleave. */
  async function raceUndoAndPatch(order: "patch-first" | "undo-first") {
    const { owner, canvasId, service } = await setup();
    const editor = await joinAsEditor(owner, canvasId);
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Renamed API" })).status,
    ).toBe(200);
    const [rename] = await eventsFor(canvasId, "entity.updated");

    const { blocker, pid } = await lockCanvas(canvasId);
    const patchRequest = () =>
      api.request("PATCH", `/api/entities/${service}`, editor.session, { metadata: { documentation: "Docs" } });
    const undoRequest = () => api.request("POST", `/api/canvases/${canvasId}/undo`, owner.session);
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      // The first request is queued on the canvas row before the second starts, so the queue order is known.
      first = order === "patch-first" ? patchRequest() : undoRequest();
      await waitForBlocked(pid, 1);
      second = order === "patch-first" ? undoRequest() : patchRequest();
      await waitForBlocked(pid, 2);
      // Both are waiting for the canvas lock: nothing of either is visible yet.
      const [untouched] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, service));
      expect(untouched.name).toBe("Renamed API");
    } finally {
      await release(blocker);
    }
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const patchResponse = order === "patch-first" ? firstResponse : secondResponse;
    const undoResponse = order === "patch-first" ? secondResponse : firstResponse;
    expect(patchResponse.status).toBe(200);
    expect(undoResponse.status).toBe(200);
    expect((await undoResponse.json()) as UndoResult).toMatchObject({ undone: true, action: "entity.updated" });

    const events = await eventsFor(canvasId);
    const patchEvent = events.filter((e) => e.action === "entity.updated").find((e) => e.id !== rename.id);
    const undoEvent = events.find((e) => e.action === "canvas.undo");
    if (!patchEvent || !undoEvent) throw new Error("Expected both an update event and an undo event");
    // The undo reverted the owner's rename in both orders, and the collaborator's change survived it.
    expect((undoEvent.metadata as { undoOf?: string }).undoOf).toBe(rename.id);
    const current = (await graph(owner.session, canvasId)).entities.find((e) => e.id === service);
    expect(current).toMatchObject({ name: "Orders API", metadata: { documentation: "Docs" } });
    // The request queued first committed first, so its event has the lower seq.
    const firstEvent = order === "patch-first" ? patchEvent : undoEvent;
    const secondEvent = order === "patch-first" ? undoEvent : patchEvent;
    expect(Number(firstEvent.seq)).toBeLessThan(Number(secondEvent.seq));
  }

  it("applies a collaborator's update committed before the undo, in seq order", async () => {
    await raceUndoAndPatch("patch-first");
  });

  it("never lets an undo that commits first overwrite the collaborator's concurrent update", async () => {
    await raceUndoAndPatch("undo-first");
  });

  it("locks the previous row of a canvas update, so concurrent renames chain their previous values", async () => {
    const { owner, canvasId } = await setup();
    const { blocker, pid } = await lockCanvas(canvasId);
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      first = api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { name: "First name" });
      await waitForBlocked(pid, 1);
      second = api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { name: "Second name" });
      await waitForBlocked(pid, 2);
    } finally {
      await release(blocker);
    }
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    const [firstEvent, secondEvent] = await eventsFor(canvasId, "canvas.updated");
    expect(firstEvent.metadata).toEqual({ fields: ["name"], previous: { name: "Checkout flow" } });
    expect(firstEvent.targetName).toBe("First name");
    expect(secondEvent.metadata).toEqual({ fields: ["name"], previous: { name: "First name" } });
    expect(secondEvent.targetName).toBe("Second name");
  });
});

describe("activity feed order", () => {
  it("follows seq even when created_at is inverted", async () => {
    const { owner, canvasId, service } = await setup();
    for (const name of ["One", "Two", "Three"])
      await api.request("PATCH", `/api/entities/${service}`, owner.session, { name });
    const stored = await eventsFor(canvasId);
    // Newest by seq gets the oldest clock value.
    for (const [index, event] of stored.entries())
      await db
        .update(canvasEvents)
        .set({
          createdAt: sql`now() - make_interval(secs => ${stored.length - index})`.mapWith(canvasEvents.createdAt),
        })
        .where(eq(canvasEvents.id, event.id));
    // Invert: the highest seq now has the smallest created_at.
    for (const [index, event] of stored.entries())
      await db
        .update(canvasEvents)
        .set({ createdAt: sql`now() - make_interval(secs => ${index + 1})`.mapWith(canvasEvents.createdAt) })
        .where(eq(canvasEvents.id, event.id));
    const feed = await api.json<{ events: Array<{ id: string }> }>(
      "GET",
      `/api/canvases/${canvasId}/activity?limit=50`,
      owner.session,
    );
    expect(feed.body.events.map((e) => e.id)).toEqual([...stored].reverse().map((e) => e.id));
  });
});

describe("canvas lock retries", () => {
  it("answers 503 and writes nothing when the canvas set keeps changing", async () => {
    const { owner, canvasId, service } = await setup();
    const finderCalls: number[] = [];
    // Every attempt first sees no canvas, then (after its work) a canvas it does not hold, so no attempt can succeed.
    const app = createApp({
      configure: (configured) => {
        configured.post("/test-lock-exhaustion/:entityId", async (context) => {
          const entityId = (context.params as { entityId: string }).entityId;
          await withCanvasLocks(
            async () => {
              finderCalls.push(finderCalls.length);
              return finderCalls.length % 2 === 1 ? [] : [canvasId];
            },
            async (tx, currentCanvasIds) => {
              await tx.update(entities).set({ name: "Written" }).where(eq(entities.id, entityId));
              await currentCanvasIds();
            },
          );
          return { ok: true };
        });
      },
    });
    const response = await app.handle(
      new Request(`http://localhost/test-lock-exhaustion/${service}`, { method: "POST" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: "The service is temporarily unavailable. Try again in a moment.",
    });
    // Five attempts, each with two canvas-set reads, and every attempt rolled back.
    expect(finderCalls).toHaveLength(10);
    const [row] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, service));
    expect(row.name).toBe("Orders API");
    expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(0);
    expect((await graph(owner.session, canvasId)).entities.find((e) => e.id === service)?.name).toBe("Orders API");
  });
});

describe("undo through two canvases that show the same object", () => {
  type Shared = Awaited<ReturnType<typeof setupShared>>;

  /** Canvas A and canvas B (same workspace) both show the service, the database and their connector. */
  async function setupShared() {
    const base = await setup();
    const canvasB = await api.createCanvas(base.owner.session, base.owner.workspaceId);
    await placeOnCanvas(base.owner.session, canvasB, base.service);
    await placeOnCanvas(base.owner.session, canvasB, base.database);
    await pool.query("insert into canvas_connections (canvas_id, connection_id) values ($1, $2)", [
      canvasB,
      base.connectionId,
    ]);
    return { ...base, canvasA: base.canvasId, canvasB };
  }

  /**
   * Two edits of one object, then a history in which canvas A's newest undoable event is the first edit and canvas
   * B's is the second. The two undos touch different fields, so a correct result reverts both.
   */
  async function splitHistory(
    shared: Shared,
    kind: "entity" | "connection",
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ) {
    const url = kind === "entity" ? `/api/entities/${shared.service}` : `/api/connections/${shared.connectionId}`;
    expect((await api.request("PATCH", url, shared.owner.session, first)).status).toBe(200);
    expect((await api.request("PATCH", url, shared.owner.session, second)).status).toBe(200);
    const action = `${kind}.updated`;
    const [eventA] = (await eventsFor(shared.canvasA, action)).slice(1);
    const [eventB] = await eventsFor(shared.canvasB, action);
    // A keeps only the first edit's event, B only the second's.
    await pool.query("delete from canvas_events where id = $1", [eventA.id]);
    const [dropOnB] = await eventsFor(shared.canvasB, action);
    await pool.query("delete from canvas_events where id = $1", [dropOnB.id]);
    expect(eventB.id).toBe(dropOnB.id);
  }

  async function lockRow(table: "entities" | "connections", id: string) {
    const blocker: PoolClient = await connect();
    await blocker.query("begin");
    await blocker.query(`select id from ${table} where id = $1 for update`, [id]);
    const { rows } = await blocker.query("select pg_backend_pid() as pid");
    return { blocker, pid: Number(rows[0].pid) };
  }

  const undoVia = (shared: Shared, canvasId: string) => () =>
    api.request("POST", `/api/canvases/${canvasId}/undo`, shared.owner.session);

  for (const kind of ["entity", "connection"] as const) {
    const table = kind === "entity" ? "entities" : "connections";
    const first = kind === "entity" ? { name: "Renamed API" } : { label: "Loads orders" };
    const second =
      kind === "entity" ? { metadata: { documentation: "Docs" } } : { metadata: { contractBody: "openapi: 3" } };

    async function currentObject(shared: Shared) {
      const g = await graph(shared.owner.session, shared.canvasA);
      return kind === "entity"
        ? g.entities.find((e) => e.id === shared.service)
        : g.connections.find((c) => c.id === shared.connectionId);
    }

    function expectBothReverted(object: { metadata: Record<string, unknown> } | undefined) {
      expect(object?.metadata).toEqual({});
      expect(kind === "entity" ? (object as { name?: string }).name : (object as { label?: string }).label).toBe(
        kind === "entity" ? "Orders API" : "",
      );
    }

    it(`keeps both results when ${kind}.updated is undone concurrently through two canvases`, async () => {
      const shared = await setupShared();
      await splitHistory(shared, kind, first, second);
      const objectId = kind === "entity" ? shared.service : shared.connectionId;
      const { blocker, pid } = await lockRow(table, objectId);
      let requests: Promise<Response>[] = [];
      try {
        requests = [undoVia(shared, shared.canvasA)(), undoVia(shared, shared.canvasB)()];
        // Both undos are in flight against the held object row: the interleaving the lost update needs.
        await waitForBlocked(pid, 2);
      } finally {
        await release(blocker);
      }
      const responses = await Promise.all(requests);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect((await response.json()) as UndoResult).toMatchObject({ undone: true, action: `${kind}.updated` });
      }
      expectBothReverted((await currentObject(shared)) as { metadata: Record<string, unknown> } | undefined);
    });

    it(`does not deadlock a ${kind} PATCH racing two undos through different canvases`, async () => {
      const shared = await setupShared();
      await splitHistory(shared, kind, first, second);
      const objectId = kind === "entity" ? shared.service : shared.connectionId;
      const url = kind === "entity" ? `/api/entities/${objectId}` : `/api/connections/${objectId}`;
      // The PATCH comes from a second editor of both canvases and changes a field neither undo touches. Its event
      // is the other actor's, and the field-level conflict scan finds no overlap in either order, so the outcome
      // does not depend on which request gets the lock first.
      const editor = await joinAsEditor(shared.owner, shared.canvasA);
      await joinExisting(shared.owner, shared.canvasB, editor);
      const { blocker, pid } = await lockRow(table, objectId);
      let requests: Promise<Response>[] = [];
      try {
        requests = [
          undoVia(shared, shared.canvasA)(),
          undoVia(shared, shared.canvasB)(),
          api.request("PATCH", url, editor.session, { description: "Edited" }),
        ];
        await waitForBlocked(pid, 3);
      } finally {
        await release(blocker);
      }
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      for (const response of responses.slice(0, 2))
        expect((await response.json()) as UndoResult).toMatchObject({ undone: true, action: `${kind}.updated` });
      const current = (await currentObject(shared)) as unknown as {
        description: string | null;
        metadata: Record<string, unknown>;
      };
      expect(current.description).toBe("Edited");
      expectBothReverted(current);
    });
  }
});

describe("undo lock conflicts", () => {
  async function lockEntities(ids: string[]) {
    const blocker: PoolClient = await connect();
    await blocker.query("begin");
    for (const id of ids) await blocker.query("select id from entities where id = $1 for update", [id]);
    const { rows } = await blocker.query("select pg_backend_pid() as pid");
    return { blocker, pid: Number(rows[0].pid) };
  }

  it("lets two undos walk no-op candidates over the same two entities in opposite order", async () => {
    const base = await setup();
    const canvasB = await api.createCanvas(base.owner.session, base.owner.workspaceId);
    await placeOnCanvas(base.owner.session, canvasB, base.service);
    await placeOnCanvas(base.owner.session, canvasB, base.database);
    const e1 = base.service;
    const e2 = base.database;
    const patch = async (id: string, body: Record<string, unknown>) =>
      expect((await api.request("PATCH", `/api/entities/${id}`, base.owner.session, body)).status).toBe(200);
    await patch(e1, { name: "One" });
    await patch(e2, { name: "Two" });
    await patch(e1, { description: "d1" });
    await patch(e2, { description: "d2" });
    const pick = async (canvasId: string, target: string, field: string) => {
      const rows = (await eventsFor(canvasId, "entity.updated")).filter(
        (row) => row.targetId === target && field in ((row.metadata as { previous: object }).previous ?? {}),
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    // Canvas A: newest is a no-op on E1, the older one a real change to E2.
    // Canvas B: newest is a no-op on E2, the older one a real change to E1.
    const keep = new Set([
      (await pick(base.canvasId, e2, "name")).id,
      (await pick(base.canvasId, e1, "description")).id,
      (await pick(canvasB, e1, "name")).id,
      (await pick(canvasB, e2, "description")).id,
    ]);
    for (const row of await db.select().from(canvasEvents).where(eq(canvasEvents.action, "entity.updated"))) {
      if (!keep.has(row.id)) await pool.query("delete from canvas_events where id = $1", [row.id]);
    }
    // Make the "newest" events no-ops: their recorded previous description is what is stored now.
    await pool.query(
      `update canvas_events set metadata = jsonb_set(metadata, '{previous,description}', $2::jsonb)
       where canvas_id = $1 and target_id = $3 and action = 'entity.updated'
         and (metadata->'previous') ? 'description'`,
      [base.canvasId, JSON.stringify("d1"), e1],
    );
    await pool.query(
      `update canvas_events set metadata = jsonb_set(metadata, '{previous,description}', $2::jsonb)
       where canvas_id = $1 and target_id = $3 and action = 'entity.updated'
         and (metadata->'previous') ? 'description'`,
      [canvasB, JSON.stringify("d2"), e2],
    );

    // Holding both rows makes each walk's first object lock (if it took one) wait; a walk that locked its no-op
    // candidate would then deadlock with the other walk as soon as both are released. The walks run without the
    // route's deadlock retry so a 40P01 would fail this test instead of being absorbed.
    const actor = {
      id: base.owner.user.id,
      name: base.owner.user.name,
      email: base.owner.user.email,
      systemRole: "user" as const,
    };
    const walk = (canvasId: string) =>
      db.transaction(async (tx) => {
        await tx.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, canvasId)).for("update");
        return applyNextUndo(tx, canvasId, actor);
      });
    const { blocker, pid } = await lockEntities([e1, e2]);
    let walks: Promise<Awaited<ReturnType<typeof walk>>>[] = [];
    try {
      walks = [walk(base.canvasId), walk(canvasB)];
      await waitForBlocked(pid, 2);
    } finally {
      await release(blocker);
    }
    for (const outcome of await Promise.all(walks)) {
      expect(outcome.undoneEvent?.action).toBe("entity.updated");
      expect(outcome.skipped.map((item) => item.reason)).toEqual(["no-op"]);
    }
    const names = Object.fromEntries(
      (await graph(base.owner.session, base.canvasId)).entities.map((entity) => [entity.id, entity.name]),
    );
    expect(names[e1]).toBe("Orders API");
    expect(names[e2]).toBe("Orders DB");
  });

  it("takes no shared lock on an entity while walking past a skipped candidate to an older update of it", async () => {
    const base = await setup();
    const canvasB = await api.createCanvas(base.owner.session, base.owner.workspaceId);
    await placeOnCanvas(base.owner.session, canvasB, base.service);
    const x = base.service;
    const owner = base.owner.session;
    const patch = async (session: string, body: Record<string, unknown>) =>
      expect((await api.request("PATCH", `/api/entities/${x}`, session, body)).status).toBe(200);
    await patch(owner, { name: "Renamed" });
    await patch(owner, { description: "Described" });
    // Canvas A keeps only the name update, canvas B only the description update, so both undos really write X.
    await pool.query(
      `delete from canvas_events where action = 'entity.updated' and target_id = $3
         and ((canvas_id = $1 and (metadata->'previous') ? 'description')
           or (canvas_id = $2 and (metadata->'previous') ? 'name'))`,
      [base.canvasId, canvasB, x],
    );
    // Newer than the update on each canvas: the owner's own placement change of X. A collaborator's later edit of X
    // overlaps it, so the walk skips it as a conflict, but only after the old code had KEY SHARE locked X for it.
    for (const canvasId of [base.canvasId, canvasB]) {
      const { status } = await api.json("PUT", `/api/canvases/${canvasId}/placements`, owner, {
        placements: [{ entityId: x, parentEntityId: null, x: 50, y: 50, width: 220, height: 120 }],
      });
      expect(status).toBe(200);
    }
    const editor = await joinAsEditor(base.owner, base.canvasId);
    await joinExisting(base.owner, canvasB, editor);
    await patch(editor.session, { metadata: { documentation: "Docs" } });

    const actor = {
      id: base.owner.user.id,
      name: base.owner.user.name,
      email: base.owner.user.email,
      systemRole: "user" as const,
    };
    // No retry wrapper: a 40P01 from a KEY SHARE -> FOR UPDATE upgrade must fail this test, not be absorbed.
    const walk = (canvasId: string) =>
      db.transaction(async (tx) => {
        await tx.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, canvasId)).for("update");
        return applyNextUndo(tx, canvasId, actor);
      });
    const { blocker, pid } = await lockEntities([x]);
    let walks: Promise<Awaited<ReturnType<typeof walk>>>[] = [];
    try {
      walks = [walk(base.canvasId), walk(canvasB)];
      await waitForBlocked(pid, 2);
    } finally {
      await release(blocker);
    }
    for (const outcome of await Promise.all(walks)) {
      expect(outcome.undoneEvent?.action).toBe("entity.updated");
      expect(outcome.skipped.map((item) => item.reason)).toEqual(["conflict"]);
    }
    const current = (await graph(owner, base.canvasId)).entities.find((entity) => entity.id === x);
    expect(current?.name).toBe("Orders API");
    expect(current?.metadata.documentation).toBe("Docs");
  });

  it("retries a deadlock or serialization abort and then answers with retryable contention", async () => {
    const abort = (code: string, wrapped: boolean) => {
      const inner = Object.assign(new Error("aborted"), { code });
      return wrapped ? Object.assign(new Error("Failed query"), { cause: inner }) : inner;
    };
    let calls = 0;
    expect(
      await retryOnLockConflict(async () => {
        calls += 1;
        if (calls === 1) throw abort("40P01", true);
        if (calls === 2) throw abort("40001", false);
        return "done";
      }),
    ).toBe("done");
    expect(calls).toBe(3);

    let attempts = 0;
    const error = await retryOnLockConflict(async () => {
      attempts += 1;
      throw abort("40P01", true);
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanvasLockContention);
    expect((error as CanvasLockContention).status).toBe(503);
    expect(attempts).toBe(3);

    // Anything else is not retried.
    let other = 0;
    const failure = await retryOnLockConflict(async () => {
      other += 1;
      throw abort("23503", false);
    }).catch((caught: unknown) => caught);
    expect(failure).not.toBeInstanceOf(CanvasLockContention);
    expect(other).toBe(1);
  });

  it("refuses an undo whose actor lost write access to the shared entity while it waited for the lock", async () => {
    const base = await setup();
    const canvasB = await api.createCanvas(base.owner.session, base.owner.workspaceId);
    const canvasC = await api.createCanvas(base.owner.session, base.owner.workspaceId, "Third");
    await placeOnCanvas(base.owner.session, canvasB, base.service);
    const editor = await joinAsEditor(base.owner, base.canvasId);
    await joinExisting(base.owner, canvasB, editor);
    await joinExisting(base.owner, canvasC, editor, "viewer");
    expect(
      (await api.request("PATCH", `/api/entities/${base.service}`, editor.session, { name: "Editor rename" })).status,
    ).toBe(200);

    // NO KEY UPDATE blocks the undo's FOR UPDATE but not the placement's foreign key (KEY SHARE).
    const blocker: PoolClient = await connect();
    await blocker.query("begin");
    await blocker.query("select id from entities where id = $1 for no key update", [base.service]);
    const { rows } = await blocker.query("select pg_backend_pid() as pid");
    const pid = Number(rows[0].pid);
    let undo: Promise<Response> | undefined;
    try {
      undo = api.request("POST", `/api/canvases/${base.canvasId}/undo`, editor.session);
      await waitForBlocked(pid, 1);
      // Committed while the undo waits: the editor is only a viewer of this canvas.
      await pool.query("insert into canvas_nodes (canvas_id, entity_id) values ($1, $2)", [canvasC, base.service]);
    } finally {
      await release(blocker);
    }
    const response = await undo;
    expect(response?.status).toBe(409);
    expect((await response?.json()) as { error: string }).toMatchObject({ error: "undo_conflict" });
    const [row] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, base.service));
    expect(row.name).toBe("Editor rename");
    const [event] = (await eventsFor(base.canvasId, "entity.updated")).filter(
      (item) => item.actorUserId !== null && item.undoneAt === null,
    );
    expect(event).toBeDefined();
  });

  it("keeps a placement committed on another canvas while entity.created is undone", async () => {
    const base = await setup();
    const canvasB = await api.createCanvas(base.owner.session, base.owner.workspaceId);
    const fresh = await api.createNode(base.owner.session, base.canvasId, { name: "Fresh", x: 900 });
    // An open transaction that has inserted (not yet committed) a placement of the entity on another canvas.
    const placer: PoolClient = await connect();
    await placer.query("begin");
    await placer.query("insert into canvas_nodes (canvas_id, entity_id) values ($1, $2)", [canvasB, fresh]);
    const { rows } = await placer.query("select pg_backend_pid() as pid");
    let undo: Promise<Response> | undefined;
    try {
      undo = api.request("POST", `/api/canvases/${base.canvasId}/undo`, base.owner.session);
      await waitForBlocked(Number(rows[0].pid), 1);
    } finally {
      await release(placer);
    }
    const response = await undo;
    expect(response?.status).toBe(200);
    expect((await response?.json()) as UndoResult).toMatchObject({ undone: true, action: "entity.created" });
    // The entity survives, still placed on the other canvas; only this canvas's placement went away.
    const placements = await pool.query("select canvas_id from canvas_nodes where entity_id = $1", [fresh]);
    expect(placements.rows.map((row: { canvas_id: string }) => row.canvas_id)).toEqual([canvasB]);
    expect(await db.select({ id: entities.id }).from(entities).where(eq(entities.id, fresh))).toHaveLength(1);
  });
});
