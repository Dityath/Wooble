import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  canvasConnections,
  canvasEvents,
  canvasNodes,
  collabDocuments,
  connections,
  db,
  entities,
  pool,
} from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import type { PreviousMetadataEntry } from "../src/modules/canvas/event-metadata";
import { isExternalMetadataKey, registerDeleteUndoHook } from "../src/modules/canvas/undo-registry";
import { type DocumentRef, withoutDocumentation } from "../src/modules/collab/documentation";
import { apiClient } from "./support/client";

const api = apiClient();
let owner: Awaited<ReturnType<typeof api.register>>;
let peer: Awaited<ReturnType<typeof api.register>>;
beforeEach(() => resetLoginAttempts());
beforeAll(async () => {
  owner = await api.register("Documentation Undo Owner");
  peer = await api.register("Documentation Undo Peer");
});

async function fixture() {
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Documentation undo");
  const source = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const target = await api.createNode(owner.session, canvasId, { name: "Orders Store" });
  const connectionId = await api.connect(owner.session, canvasId, source, target);
  // Isolate the specific history entry under test from fixture creation events.
  await db.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.canvasId, canvasId));
  return {
    canvasId,
    entity: { kind: "entity", id: source } satisfies DocumentRef,
    connection: { kind: "connection", id: connectionId } satisfies DocumentRef,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Format = "new" | "v2" | "pre-v2";
const formats: Format[] = ["new", "v2", "pre-v2"];
const kinds = ["entity", "connection"] as const;
const tableFor = (ref: DocumentRef) => (ref.kind === "entity" ? entities : connections);

function updateMetadata(format: Format, entry: PreviousMetadataEntry): Record<string, unknown> {
  if (format === "pre-v2") {
    return { fields: ["metadata"], previous: { metadata: entry.present ? { documentation: entry.value } : {} } };
  }
  return {
    version: 2,
    fields: ["metadata"],
    previous: {},
    previousMetadata: format === "v2" ? { documentation: entry } : {},
    ...(format === "new" ? { documentationUndo: entry } : {}),
  };
}

async function record(
  f: Fixture,
  ref: DocumentRef,
  action: "updated" | "deleted",
  metadata: Record<string, unknown>,
  actor = owner,
) {
  const [row] = await db
    .insert(canvasEvents)
    .values({
      canvasId: f.canvasId,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      action: `${ref.kind}.${action}`,
      targetType: ref.kind,
      targetId: ref.id,
      targetName: "Documentation target",
      metadata,
    })
    .returning();
  return row;
}

async function setMetadata(ref: DocumentRef, metadata: Record<string, unknown>) {
  const table = tableFor(ref);
  await db.update(table).set({ metadata }).where(eq(table.id, ref.id));
}

async function readMetadata(ref: DocumentRef) {
  const table = tableFor(ref);
  const [row] = await db.select({ metadata: table.metadata }).from(table).where(eq(table.id, ref.id));
  expect(row).toBeDefined();
  return row.metadata as Record<string, unknown>;
}

async function undo(f: Fixture) {
  return api.json<Record<string, unknown>>("POST", `/api/canvases/${f.canvasId}/undo`, owner.session);
}

async function bootstrap(ref: DocumentRef, mirror = "Mirror text") {
  await db.insert(collabDocuments).values({
    workspaceId: owner.workspaceId,
    objectKind: ref.kind,
    objectId: ref.id,
    field: "documentation",
    state: Buffer.from([1, 0, 255]),
    bootstrapVersion: 1,
    mirrorMarkdown: mirror,
    mirrorSha256: createHash("sha256").update(mirror).digest("hex"),
  });
}

/** Match route snapshots: timestamp columns are not part of the event format. */
async function snapshotRows(f: Fixture) {
  const [entity] = await db
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      type: entities.type,
      name: entities.name,
      description: entities.description,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(eq(entities.id, f.entity.id));
  const [connection] = await db
    .select({
      id: connections.id,
      workspaceId: connections.workspaceId,
      sourceEntityId: connections.sourceEntityId,
      targetEntityId: connections.targetEntityId,
      type: connections.type,
      label: connections.label,
      description: connections.description,
      metadata: connections.metadata,
    })
    .from(connections)
    .where(eq(connections.id, f.connection.id));
  return { entity, connection };
}

describe("canvas undo delegates documentation to its writer", () => {
  it("registers documentation as external when createApp constructs the API", () => {
    expect(isExternalMetadataKey("documentation")).toBe(true);
  });

  for (const kind of kinds) {
    for (const format of formats) {
      it(`restores legacy ${kind} documentation from ${format} update history`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await setMetadata(ref, { documentation: "Current text" });
        const event = await record(f, ref, "updated", updateMetadata(format, { present: true, value: "Old text" }));
        const result = await undo(f);
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ undone: true, action: `${kind}.updated`, skipped: [] });
        expect(await readMetadata(ref)).toEqual({ documentation: "Old text" });
        const [stored] = await db.select().from(canvasEvents).where(eq(canvasEvents.id, event.id));
        expect(stored.undoneAt).not.toBeNull();
      });

      it(`removes a legacy ${kind} documentation key absent before the ${format} update`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await setMetadata(ref, { documentation: "Added text" });
        await record(f, ref, "updated", updateMetadata(format, { present: false }));
        expect((await undo(f)).body).toMatchObject({ undone: true, action: `${kind}.updated` });
        expect(Object.hasOwn(await readMetadata(ref), "documentation")).toBe(false);
      });

      it(`keeps bootstrapped ${kind} text and restores other fields from ${format} history`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await setMetadata(ref, { documentation: "Legacy edit", retained: "current" });
        const field = kind === "entity" ? "name" : "label";
        const metadata = updateMetadata(format, { present: true, value: "Old text" });
        metadata.fields = [field, "metadata"];
        metadata.previous = {
          ...(metadata.previous as Record<string, unknown>),
          [field]: "Before rename",
          ...(format === "pre-v2" ? { metadata: { documentation: "Old text", retained: "current" } } : {}),
        };
        await record(f, ref, "updated", metadata);
        // Bootstrap happens after the legacy edit; the mirror is now authoritative.
        await bootstrap(ref);
        const result = await undo(f);
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ undone: true, action: `${kind}.updated`, skipped: [] });
        expect(await readMetadata(ref)).toEqual({ documentation: "Mirror text", retained: "current" });
        if (kind === "entity") {
          const [row] = await db.select().from(entities).where(eq(entities.id, ref.id));
          expect(row.name).toBe("Before rename");
        } else {
          const [row] = await db.select().from(connections).where(eq(connections.id, ref.id));
          expect(row.label).toBe("Before rename");
        }
      });
    }

    it(`treats an identical legacy ${kind} documentation restore as a no-op`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await setMetadata(ref, { documentation: "Same text", retained: "current" });
      const event = await record(f, ref, "updated", updateMetadata("new", { present: true, value: "Same text" }));
      expect((await undo(f)).body).toEqual({ undone: false });
      expect(await readMetadata(ref)).toEqual({ documentation: "Same text", retained: "current" });
      const [stored] = await db.select().from(canvasEvents).where(eq(canvasEvents.id, event.id));
      expect(stored.undoneAt).not.toBeNull();
    });

    it(`treats already-absent legacy ${kind} documentation as a no-op`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await record(f, ref, "updated", updateMetadata("new", { present: false }));
      expect((await undo(f)).body).toEqual({ undone: false });
      expect(await readMetadata(ref)).toEqual({});
    });

    it(`skips a documentation-only ${kind} undo after bootstrap`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await setMetadata(ref, { documentation: "Mirror text" });
      await record(f, ref, "updated", updateMetadata("new", { present: true, value: "Old text" }));
      await bootstrap(ref);
      expect((await undo(f)).body).toEqual({ undone: false });
      expect(await readMetadata(ref)).toEqual({ documentation: "Mirror text" });
    });

    it(`reprojects the ${kind} mirror even when the undone update did not name documentation`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await setMetadata(ref, { documentation: "Stale projection", retained: "current" });
      await record(f, ref, "updated", {
        version: 2,
        fields: [kind === "entity" ? "name" : "label"],
        previous: kind === "entity" ? { name: "Old name" } : { label: "Old label" },
        previousMetadata: {},
      });
      await bootstrap(ref, "");
      expect((await undo(f)).body).toMatchObject({ undone: true, action: `${kind}.updated` });
      expect(await readMetadata(ref)).toEqual({ retained: "current" });
    });

    for (const [earlier, later] of [
      ["new", "v2"],
      ["v2", "new"],
      ["pre-v2", "new"],
    ] as const) {
      it(`blocks ${kind} documentation undo across ${earlier}/${later} collaborator history`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await setMetadata(ref, { documentation: "Peer text" });
        const mine = await record(f, ref, "updated", updateMetadata(earlier, { present: true, value: "Original" }));
        await record(f, ref, "updated", updateMetadata(later, { present: true, value: "Owner text" }), peer);
        const result = await undo(f);
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({
          error: "undo_conflict",
          skipped: [{ action: `${kind}.updated`, targetName: "Documentation target", reason: "conflict" }],
        });
        expect(await readMetadata(ref)).toEqual({ documentation: "Peer text" });
        const [stored] = await db.select().from(canvasEvents).where(eq(canvasEvents.id, mine.id));
        expect(stored.undoneAt).toBeNull();
      });
    }
  }

  it("keeps conflict detection for documentation edits made through the registered routes", async () => {
    const f = await fixture();
    const token = await api.invite(owner.session, `/api/canvases/${f.canvasId}/invitations`, "editor");
    expect((await api.request("POST", `/api/invitations/${token}/accept`, peer.session)).status).toBe(200);
    expect(
      (
        await api.request("PATCH", `/api/entities/${f.entity.id}`, owner.session, {
          metadata: { documentation: "Owner text" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request("PATCH", `/api/entities/${f.entity.id}`, peer.session, {
          metadata: { documentation: "Peer text" },
        })
      ).status,
    ).toBe(200);
    const result = await undo(f);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "undo_conflict" });
    expect(await readMetadata(f.entity)).toEqual({ documentation: "Peer text" });
  });
});

describe("delete undo restores documentation only for reinserted owners", () => {
  for (const format of ["new", "old"] as const) {
    for (const kind of kinds) {
      for (const bootstrapped of [false, true]) {
        it(`restores ${format} ${kind} delete history for ${bootstrapped ? "bootstrapped" : "legacy"} owners`, async () => {
          const f = await fixture();
          const refs = kind === "entity" ? [f.entity, f.connection] : [f.connection];
          for (const ref of refs) {
            await setMetadata(ref, { documentation: "Snapshot text", retained: ref.kind });
            if (bootstrapped) await bootstrap(ref);
          }
          const { entity, connection } = await snapshotRows(f);
          const [placement] = await db.select().from(canvasNodes).where(eq(canvasNodes.entityId, f.entity.id));
          const [link] = await db
            .select()
            .from(canvasConnections)
            .where(eq(canvasConnections.connectionId, f.connection.id));
          const documentation = Object.fromEntries(
            refs.map((ref) => [`${ref.kind}:${ref.id}`, { present: true, value: "Snapshot text" }]),
          );
          const connectionSnapshot = {
            ...connection,
            bend: link.bend,
            metadata: format === "new" ? withoutDocumentation(connection.metadata) : connection.metadata,
          };
          // New bootstrapped delete events deliberately contain no old document text anywhere.
          const section = format === "new" && !bootstrapped ? { documentation } : {};
          const metadata =
            kind === "entity"
              ? {
                  snapshot: {
                    entities: [
                      {
                        ...entity,
                        metadata: format === "new" ? withoutDocumentation(entity.metadata) : entity.metadata,
                      },
                    ],
                    connections: [connectionSnapshot],
                    placements: [placement],
                    ...section,
                  },
                }
              : { connection: connectionSnapshot, ...section };
          if (kind === "entity") await db.delete(entities).where(eq(entities.id, f.entity.id));
          else await db.delete(connections).where(eq(connections.id, f.connection.id));
          await record(f, f[kind], "deleted", metadata);
          const result = await undo(f);
          expect(result.status).toBe(200);
          expect(result.body).toEqual({ undone: true, action: `${kind}.deleted`, skipped: [] });
          for (const ref of refs) {
            expect(await readMetadata(ref)).toEqual({
              documentation: bootstrapped ? "Mirror text" : "Snapshot text",
              retained: ref.kind,
            });
          }
          const graph = await api.json<{ entities: Array<{ id: string }>; connections: Array<{ id: string }> }>(
            "GET",
            `/api/canvases/${f.canvasId}/graph`,
            owner.session,
          );
          expect(graph.status).toBe(200);
          expect(graph.body.entities.map((row) => row.id)).toContain(f.entity.id);
          expect(graph.body.connections.map((row) => row.id)).toContain(f.connection.id);
        });
      }
    }
  }

  it("leaves existing entity and connection documentation untouched during subtree restore", async () => {
    const f = await fixture();
    for (const ref of [f.entity, f.connection]) {
      await setMetadata(ref, { documentation: "Current owner text" });
      await bootstrap(ref);
    }
    const { entity, connection } = await snapshotRows(f);
    await record(f, f.entity, "deleted", {
      snapshot: {
        entities: [{ ...entity, metadata: { documentation: "Snapshot text" } }],
        connections: [{ ...connection, metadata: { documentation: "Snapshot text" }, bend: null }],
        placements: [],
        documentation: {
          [`entity:${f.entity.id}`]: { present: true, value: "New section text" },
          [`connection:${f.connection.id}`]: { present: true, value: "New section text" },
        },
      },
    });
    expect((await undo(f)).body).toMatchObject({ undone: true, action: "entity.deleted" });
    expect(await readMetadata(f.entity)).toEqual({ documentation: "Current owner text" });
    expect(await readMetadata(f.connection)).toEqual({ documentation: "Current owner text" });
  });

  it("leaves an existing connection's documentation untouched during connection restore", async () => {
    const f = await fixture();
    await setMetadata(f.connection, { documentation: "Current owner text" });
    const { connection } = await snapshotRows(f);
    await record(f, f.connection, "deleted", {
      connection: { ...connection, metadata: { documentation: "Snapshot text" }, bend: null },
      documentation: { [`connection:${f.connection.id}`]: { present: true, value: "New section text" } },
    });
    expect((await undo(f)).body).toMatchObject({ undone: true, action: "connection.deleted" });
    expect(await readMetadata(f.connection)).toEqual({ documentation: "Current owner text" });
  });
});

describe("documentation projection rolls back with failed undo", () => {
  for (const bootstrapped of [false, true]) {
    it(`rolls back ${bootstrapped ? "bootstrapped mirror" : "legacy documentation"} projection when marking an update undone fails`, async () => {
      const f = await fixture();
      await setMetadata(f.entity, { documentation: "Current text", retained: true });
      const metadata = updateMetadata("new", { present: true, value: "Old text" });
      metadata.fields = ["name", "metadata"];
      metadata.previous = { name: "Before rename" };
      const event = await record(f, f.entity, "updated", metadata);
      if (bootstrapped) await bootstrap(f.entity);
      const [before] = await db.select().from(entities).where(eq(entities.id, f.entity.id));
      const hash = (text: unknown) => createHash("sha256").update(String(text)).digest("hex");
      const beforeHash = hash((before.metadata as Record<string, unknown>).documentation);
      const projected = bootstrapped ? "Mirror text" : "Old text";
      const name = `wooble_test_undo_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        // Fail only after both the ordinary field restore and documentation projection are visible.
        // If projection never ran, undo succeeds and the status assertion below fails.
        await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id = '${event.id}'::uuid AND NEW.undone_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM entities WHERE id = '${f.entity.id}'::uuid
              AND name = 'Before rename' AND metadata->>'documentation' = '${projected}'
          ) THEN RAISE EXCEPTION 'mark undone refused after documentation projection for test'; END IF;
          RETURN NEW; END $$`);
        await pool.query(
          `CREATE TRIGGER ${name} BEFORE UPDATE ON canvas_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        );
        expect((await undo(f)).status).toBe(500);
        const [after] = await db.select().from(entities).where(eq(entities.id, f.entity.id));
        expect(after.name).toBe(before.name);
        expect(after.metadata).toEqual(before.metadata);
        expect(hash((after.metadata as Record<string, unknown>).documentation)).toBe(beforeHash);
        const [stored] = await db.select().from(canvasEvents).where(eq(canvasEvents.id, event.id));
        expect(stored.undoneAt).toBeNull();
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${name} ON canvas_events`);
        await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
      }
    });
  }

  for (const kind of kinds) {
    it(`rolls back ${kind} delete restoration after documentation has been projected`, async () => {
      const f = await fixture();
      const refs = kind === "entity" ? [f.entity, f.connection] : [f.connection];
      for (const ref of refs) await setMetadata(ref, { documentation: "Snapshot text", retained: ref.kind });
      const { entity, connection } = await snapshotRows(f);
      const [placement] = await db.select().from(canvasNodes).where(eq(canvasNodes.entityId, f.entity.id));
      const [link] = await db
        .select()
        .from(canvasConnections)
        .where(eq(canvasConnections.connectionId, f.connection.id));
      const hookName = `wooble_test_restore_${crypto.randomUUID()}`;
      let reachedHook = false;
      const unregister = registerDeleteUndoHook({
        name: hookName,
        async snapshot() {
          return true;
        },
        async restore(tx, target) {
          expect(target).toEqual({ kind, ids: [f[kind].id] });
          for (const ref of refs) {
            const table = tableFor(ref);
            const [row] = await tx.select().from(table).where(eq(table.id, ref.id));
            expect(row?.metadata as Record<string, unknown>).toEqual({
              documentation: "Snapshot text",
              retained: ref.kind,
            });
          }
          const links = await tx
            .select()
            .from(canvasConnections)
            .where(eq(canvasConnections.connectionId, f.connection.id));
          expect(links).toHaveLength(1);
          if (kind === "entity") {
            const nodes = await tx.select().from(canvasNodes).where(eq(canvasNodes.entityId, f.entity.id));
            expect(nodes).toHaveLength(1);
          }
          reachedHook = true;
          throw new Error("delete undo refused after documentation projection for test");
        },
      });
      try {
        const documentation = Object.fromEntries(
          refs.map((ref) => [`${ref.kind}:${ref.id}`, { present: true, value: "Snapshot text" }]),
        );
        const connectionSnapshot = {
          ...connection,
          metadata: withoutDocumentation(connection.metadata),
          bend: link.bend,
        };
        const metadata =
          kind === "entity"
            ? {
                snapshot: {
                  entities: [{ ...entity, metadata: withoutDocumentation(entity.metadata) }],
                  connections: [connectionSnapshot],
                  placements: [placement],
                  documentation,
                },
              }
            : { connection: connectionSnapshot, documentation };
        if (kind === "entity") await db.delete(entities).where(eq(entities.id, f.entity.id));
        else await db.delete(connections).where(eq(connections.id, f.connection.id));
        const event = await record(f, f[kind], "deleted", { ...metadata, hooks: { [hookName]: true } });
        expect((await undo(f)).status).toBe(500);
        expect(reachedHook).toBe(true);
        for (const ref of refs) {
          const table = tableFor(ref);
          expect(await db.select().from(table).where(eq(table.id, ref.id))).toHaveLength(0);
        }
        expect(
          await db.select().from(canvasConnections).where(eq(canvasConnections.connectionId, f.connection.id)),
        ).toHaveLength(0);
        if (kind === "entity") {
          expect(await db.select().from(canvasNodes).where(eq(canvasNodes.entityId, f.entity.id))).toHaveLength(0);
        }
        const [stored] = await db.select().from(canvasEvents).where(eq(canvasEvents.id, event.id));
        expect(stored.undoneAt).toBeNull();
      } finally {
        unregister();
      }
    });
  }
});
