import { beforeEach, describe, expect, it } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { canvasEvents, db, entities, pool } from "@wooble/db";
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
        documentation: { present: false },
      },
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
 * waiting on a lock. Postgres reports a queued waiter as blocked by the waiter ahead of it, so this counts
 * lock waits instead of looking for the blocker's pid alone.
 */
async function waitForBlocked(count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
    );
    if (Number(rows[0].n) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} backend(s) waiting on a lock`);
}

async function lockCanvas(canvasId: string) {
  const blocker: PoolClient = await connect();
  await blocker.query("begin");
  await blocker.query("select id from canvases where id = $1 for update", [canvasId]);
  return { blocker };
}

describe("lock order and event order", () => {
  it("takes the canvas lock before the entity lock", async () => {
    const { owner, canvasId, service } = await setup();
    const { blocker } = await lockCanvas(canvasId);
    let patch: Promise<Response> | undefined;
    try {
      patch = api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Ordered" });
      await waitForBlocked(1);
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
      await blocker.query("commit");
      blocker.release();
    }
    expect((await patch)?.status).toBe(200);
    expect(await eventsFor(canvasId, "entity.updated")).toHaveLength(1);
  });

  it("completes a concurrent update and undo without deadlock, in seq order", async () => {
    const { owner, canvasId, service } = await setup();
    await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { name: "Before" });
    const { blocker } = await lockCanvas(canvasId);
    let patch: Promise<Response> | undefined;
    let undo: Promise<Response> | undefined;
    try {
      patch = api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Raced" });
      undo = api.request("POST", `/api/canvases/${canvasId}/undo`, owner.session);
      await waitForBlocked(2);
      const [untouched] = await db.select({ name: entities.name }).from(entities).where(eq(entities.id, service));
      expect(untouched.name).toBe("Orders API");
    } finally {
      await blocker.query("commit");
      blocker.release();
    }
    const patchResponse = await patch;
    const undoResponse = await undo;
    expect(patchResponse?.status).toBe(200);
    expect(undoResponse?.status).toBe(200);
    const undoBody = (await undoResponse?.json()) as UndoResult;

    const events = await eventsFor(canvasId);
    const patchEvent = events.find((e) => e.action === "entity.updated");
    const undoEvent = events.find((e) => e.action === "canvas.undo");
    expect(patchEvent).toBeDefined();
    if (!patchEvent) return;
    if (undoEvent) {
      const undoOf = (undoEvent.metadata as { undoOf?: string }).undoOf;
      if (undoEvent.seq > patchEvent.seq) {
        // The undo committed after the update, so it saw (and reverted) it.
        expect(undoOf).toBe(patchEvent.id);
        expect(undoBody.action).toBe("entity.updated");
      } else {
        // The undo committed first, so the update was not yet visible to it.
        expect(undoOf).not.toBe(patchEvent.id);
      }
    } else {
      expect(undoBody.undone).toBe(false);
    }
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
