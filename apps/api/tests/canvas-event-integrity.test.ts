import { beforeEach, describe, expect, it } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { canvasEvents, db } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Entity = { id: string; name: string; metadata: Record<string, unknown> };
type Graph = {
  canvas: { name: string; description: string };
  entities: Entity[];
  connections: Array<{ id: string; label: string; metadata: Record<string, unknown> }>;
};

/** An owner and an invited canvas editor sharing one canvas with a service, a database, and a connector. */
async function sharedCanvas() {
  const owner = await api.register("Event Owner");
  const editor = await api.register("Event Editor");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Fulfilment");
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor");
  expect((await api.request("POST", `/api/invitations/${token}/accept`, editor.session)).status).toBe(200);
  const service = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const database = await api.createNode(owner.session, canvasId, { type: "database", name: "Orders DB", x: 500 });
  const connectionId = await api.connect(owner.session, canvasId, service, database);
  const graph = async () => (await api.json<Graph>("GET", `/api/canvases/${canvasId}/graph`, owner.session)).body;
  const entity = async (id: string) => (await graph()).entities.find((item) => item.id === id) as Entity;
  return { owner, editor, canvasId, service, database, connectionId, graph, entity };
}

async function eventActions(canvasId: string) {
  const rows = await db
    .select({ action: canvasEvents.action })
    .from(canvasEvents)
    .where(eq(canvasEvents.canvasId, canvasId))
    .orderBy(asc(canvasEvents.createdAt));
  return rows.map((row) => row.action);
}

/**
 * Makes every canvas_events insert fail for rows whose target name starts with
 * the given prefix, so a test can prove the change rolls back with its history.
 */
async function rejectEventsNamed(prefix: string, run: () => Promise<void>) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const fn = sql.raw(`reject_canvas_event_${suffix}`);
  const trigger = sql.raw(`reject_canvas_event_${suffix}_trigger`);
  await db.execute(sql`
    create function ${fn}() returns trigger language plpgsql as $$
    begin
      if new.target_name like ${sql.raw(`'${prefix}%'`)} then
        raise exception 'history write rejected';
      end if;
      return new;
    end $$`);
  await db.execute(sql`create trigger ${trigger} before insert on canvas_events for each row execute function ${fn}()`);
  try {
    await run();
  } finally {
    await db.execute(sql`drop trigger ${trigger} on canvas_events`);
    await db.execute(sql`drop function ${fn}()`);
  }
}

/**
 * Holds a SHARE lock on canvas_events so requests pause exactly where they
 * write history. Returns a release function.
 */
async function pauseEventInserts() {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`lock table canvas_events in share mode`);
    locked();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await holder;
  };
}

/** Waits until this database has at least `count` backends blocked on a lock. */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.waiting ?? 0) >= count) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} blocked backends`);
}

describe("canvas events commit with the change they describe", () => {
  it("rolls back an entity edit when its history row cannot be written", async () => {
    const { owner, canvasId, service, entity } = await sharedCanvas();
    await rejectEventsNamed("Rejected", async () => {
      const response = await api.request("PATCH", `/api/entities/${service}`, owner.session, {
        name: "Rejected Orders",
      });
      expect(response.status).toBe(500);
    });
    expect((await entity(service)).name).toBe("Orders API");
    expect(await eventActions(canvasId)).not.toContain("entity.updated");
  });

  it("rolls back a connection edit when its history row cannot be written", async () => {
    const { owner, canvasId, connectionId, graph } = await sharedCanvas();
    await rejectEventsNamed("Rejected", async () => {
      const response = await api.request("PATCH", `/api/connections/${connectionId}`, owner.session, {
        label: "Rejected label",
      });
      expect(response.status).toBe(500);
    });
    expect((await graph()).connections[0].label).toBe("");
    expect(await eventActions(canvasId)).not.toContain("connection.updated");
  });

  it("rolls back a canvas edit when its history row cannot be written", async () => {
    const { owner, canvasId, graph } = await sharedCanvas();
    await rejectEventsNamed("Rejected", async () => {
      const response = await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, {
        name: "Rejected canvas",
      });
      expect(response.status).toBe(500);
    });
    expect((await graph()).canvas.name).toBe("Fulfilment");
    expect(await eventActions(canvasId)).not.toContain("canvas.updated");
  });

  it("records an edit on every canvas that shows the entity", async () => {
    const { owner, canvasId, service } = await sharedCanvas();
    const second = await api.createCanvas(owner.session, owner.workspaceId, "Second view");
    const placed = await api.request("PUT", `/api/canvases/${second}/placements`, owner.session, {
      placements: [{ entityId: service, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 }],
    });
    expect(placed.status).toBe(200);
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Order Service" })).status,
    ).toBe(200);
    for (const id of [canvasId, second]) {
      const [row] = await db
        .select({ id: canvasEvents.id })
        .from(canvasEvents)
        .where(and(eq(canvasEvents.canvasId, id), eq(canvasEvents.action, "entity.updated")));
      expect(row).toBeDefined();
    }
  });
});

describe("undo is ordered after concurrently committed edits", () => {
  it("never overwrites a collaborator's rename that committed while the undo waited", async () => {
    const { owner, editor, canvasId, service, entity } = await sharedCanvas();
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Order Service" })).status,
    ).toBe(200);

    // The collaborator's edit pauses at its history write, after changing the
    // row but before committing; the owner's undo is issued at that moment.
    const resume = await pauseEventInserts();
    const collaborator = api.request("PATCH", `/api/entities/${service}`, editor.session, { name: "Checkout API" });
    await waitForLockWaiters(1);
    const undo = api.request("POST", `/api/canvases/${canvasId}/undo`, owner.session);
    await waitForLockWaiters(2);
    await resume();

    expect((await collaborator).status).toBe(200);
    // The rename is skipped as superseded; the walk reaches the owner's older connector instead.
    const undone = await undo;
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({
      undone: true,
      action: "connection.created",
      skipped: [{ action: "entity.updated", targetName: "Order Service", reason: "conflict" }],
    });
    expect((await entity(service)).name).toBe("Checkout API");
    // History is in commit order: the owner's rename, the collaborator's, then the undo.
    const history = await db
      .select({ action: canvasEvents.action, actorUserId: canvasEvents.actorUserId })
      .from(canvasEvents)
      .where(eq(canvasEvents.canvasId, canvasId))
      .orderBy(asc(canvasEvents.createdAt));
    expect(history.slice(-3)).toEqual([
      { action: "entity.updated", actorUserId: owner.user.id },
      { action: "entity.updated", actorUserId: editor.user.id },
      { action: "canvas.undo", actorUserId: owner.user.id },
    ]);
  });

  it("reverts only the rename when a collaborator's documentation edit commits while the undo waits", async () => {
    const { owner, editor, canvasId, service, entity } = await sharedCanvas();
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Order Service" })).status,
    ).toBe(200);

    const resume = await pauseEventInserts();
    const collaborator = api.request("PATCH", `/api/entities/${service}`, editor.session, {
      metadata: { documentation: "Reserves stock before charging." },
    });
    await waitForLockWaiters(1);
    const undo = api.request("POST", `/api/canvases/${canvasId}/undo`, owner.session);
    await waitForLockWaiters(2);
    await resume();

    expect((await collaborator).status).toBe(200);
    const undone = await undo;
    expect(await undone.json()).toEqual({ undone: true, action: "entity.updated", skipped: [] });
    expect(await entity(service)).toMatchObject({
      name: "Orders API",
      metadata: { documentation: "Reserves stock before charging." },
    });
  });
});

describe("the activity feed exposes summaries, not earlier content", () => {
  type Activity = {
    events: Array<{ action: string; targetName: string | null; metadata: Record<string, unknown>; undoneAt: unknown }>;
  };

  it("never shows a viewer or link guest earlier documentation, contracts, schema, or canvas text", async () => {
    const { owner, canvasId, service, database, connectionId } = await sharedCanvas();
    const viewer = await api.register("Event Viewer");
    const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "viewer");
    expect((await api.request("POST", `/api/invitations/${token}/accept`, viewer.session)).status).toBe(200);

    const secrets = {
      documentation: "Fictional draft: card numbers are logged here",
      schemaSql: "create table draft_secret_cards (pan text);",
      contractBody: "openapi: 3.1.0 # draft secret contract",
      canvasDescription: "Draft secret canvas note",
    };
    const patch = (url: string, payload: unknown) => api.request("PATCH", url, owner.session, payload);
    expect(
      (await patch(`/api/entities/${service}`, { metadata: { documentation: secrets.documentation } })).status,
    ).toBe(200);
    expect((await patch(`/api/entities/${service}`, { metadata: { documentation: "Public notes" } })).status).toBe(200);
    expect((await patch(`/api/entities/${database}`, { metadata: { schemaSql: secrets.schemaSql } })).status).toBe(200);
    expect(
      (await patch(`/api/connections/${connectionId}`, { metadata: { contractBody: secrets.contractBody } })).status,
    ).toBe(200);
    expect((await patch(`/api/connections/${connectionId}`, { metadata: { contractBody: null } })).status).toBe(200);
    expect((await patch(`/api/canvases/${canvasId}`, { description: secrets.canvasDescription })).status).toBe(200);
    expect((await patch(`/api/canvases/${canvasId}`, { description: "Public", shareMode: "link" })).status).toBe(200);
    // Deletes snapshot the whole subtree, including the schema text.
    expect((await api.request("DELETE", `/api/canvases/${canvasId}/entities/${database}`, owner.session)).status).toBe(
      200,
    );
    // Rows written by earlier builds still hold full previous metadata.
    await db.insert(canvasEvents).values({
      canvasId,
      actorUserId: owner.user.id,
      actorName: "Event Owner",
      action: "entity.updated",
      targetType: "entity",
      targetId: service,
      targetName: "Orders API",
      metadata: {
        fields: ["name"],
        previous: { name: "Orders API", metadata: { documentation: secrets.documentation } },
      },
    });

    const viewerFeed = await api.json<Activity>("GET", `/api/canvases/${canvasId}/activity`, viewer.session);
    // A signed-in non-member reads a link-shared canvas as a viewer; anonymous guests get no feed at all.
    const linkGuest = await api.register("Link Guest");
    const guestFeed = await api.json<Activity>("GET", `/api/canvases/${canvasId}/activity`, linkGuest.session);
    expect((await api.request("GET", `/api/canvases/${canvasId}/activity`)).status).toBe(401);
    for (const feed of [viewerFeed, guestFeed]) {
      expect(feed.status).toBe(200);
      const text = JSON.stringify(feed.body);
      for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
      expect(text).not.toContain('"previous"');
      expect(text).not.toContain('"snapshot"');
    }

    const metadataFor = (action: string) =>
      viewerFeed.body.events.filter((event) => event.action === action).map((event) => event.metadata);
    expect(metadataFor("entity.deleted")).toEqual([{ removedNodes: 1, removedConnections: 1 }]);
    expect(metadataFor("canvas.updated")).toEqual([
      { fields: ["description", "shareMode"] },
      { fields: ["description"] },
    ]);
    expect(metadataFor("connection.updated")).toEqual([
      { fields: ["metadata"], metadataKeys: ["contractBody"] },
      { fields: ["metadata"], metadataKeys: ["contractBody"] },
    ]);
    expect(metadataFor("entity.created")).toEqual([{ type: "database" }, { type: "service" }]);
  });

  it("keeps the undo summary the activity log shows", async () => {
    const { owner, canvasId, service } = await sharedCanvas();
    expect(
      (await api.request("PATCH", `/api/entities/${service}`, owner.session, { name: "Order Service" })).status,
    ).toBe(200);
    expect((await api.request("POST", `/api/canvases/${canvasId}/undo`, owner.session)).status).toBe(200);
    const feed = await api.json<Activity>("GET", `/api/canvases/${canvasId}/activity`, owner.session);
    const [undo, update] = feed.body.events;
    expect(undo).toMatchObject({ action: "canvas.undo", targetName: "Order Service", undoneAt: null });
    expect(undo.metadata).toEqual({ undoOf: expect.any(String), undoneAction: "entity.updated", skipped: [] });
    expect(update).toMatchObject({ action: "entity.updated", metadata: { fields: ["name"], metadataKeys: [] } });
    expect(update.undoneAt).toEqual(expect.any(String));
  });
});
