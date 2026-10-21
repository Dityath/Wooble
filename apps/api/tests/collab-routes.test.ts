import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { canvasEvents, collabDocuments, connections, db, entities } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import type { PreviousMetadataEntry } from "../src/modules/canvas/event-metadata";
import type { DocumentRef } from "../src/modules/collab/documentation";
import { apiClient } from "./support/client";

const api = apiClient();
let owner: Awaited<ReturnType<typeof api.register>>;
beforeEach(() => resetLoginAttempts());
beforeAll(async () => {
  owner = await api.register("Fictional Route Writer");
});

async function fixture() {
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Fictional documentation routes");
  const source = await api.createNode(owner.session, canvasId, { type: "system", name: "Fictional Orders" });
  const child = await api.createNode(owner.session, canvasId, { name: "Fictional Worker", parentEntityId: source });
  const target = await api.createNode(owner.session, canvasId, { name: "Fictional Storage" });
  const connectionId = await api.connect(owner.session, canvasId, child, target);
  return { canvasId, entity: source, connection: connectionId, child };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type MetadataRow = { metadata: Record<string, unknown> };
type DeleteSnapshot = {
  entities: Array<MetadataRow & { id: string }>;
  connections: Array<MetadataRow & { id: string }>;
  documentation?: Record<string, PreviousMetadataEntry>;
};

const urlFor = (ref: DocumentRef) => `/api/${ref.kind === "entity" ? "entities" : "connections"}/${ref.id}`;
const otherMetadata = (kind: DocumentRef["kind"]) =>
  kind === "entity" ? { language: "TypeScript" } : { contract: "Fictional request" };
const changedMetadata = (kind: DocumentRef["kind"]) =>
  kind === "entity" ? { framework: "Fictional framework" } : { direction: "two-way" };

async function patch(ref: DocumentRef, metadata: Record<string, unknown>) {
  return api.json<MetadataRow>("PATCH", urlFor(ref), owner.session, { metadata });
}

async function row(ref: DocumentRef) {
  const table = ref.kind === "entity" ? entities : connections;
  const [result] = await db.select().from(table).where(eq(table.id, ref.id));
  return result;
}

async function events(f: Fixture) {
  return db.select().from(canvasEvents).where(eq(canvasEvents.canvasId, f.canvasId)).orderBy(desc(canvasEvents.seq));
}

async function lastEvent(f: Fixture, ref: DocumentRef, action: "updated" | "deleted") {
  const [event] = await db
    .select()
    .from(canvasEvents)
    .where(
      and(
        eq(canvasEvents.canvasId, f.canvasId),
        eq(canvasEvents.targetId, ref.id),
        eq(canvasEvents.action, `${ref.kind}.${action}`),
      ),
    )
    .orderBy(desc(canvasEvents.seq))
    .limit(1);
  expect(event).toBeDefined();
  return event.metadata;
}

async function bootstrap(ref: DocumentRef, mirror: string) {
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

describe("documentation route writer", () => {
  for (const kind of ["entity", "connection"] as const) {
    it(`PATCH ${kind} returns the writer value and records separate documentation undo state`, async () => {
      const f = await fixture();
      const ref = { kind, id: f[kind] };
      expect((await patch(ref, { ...otherMetadata(kind), documentation: "Original notes" })).status).toBe(200);
      const first = await lastEvent(f, ref, "updated");
      expect(first.documentationUndo).toEqual({ present: false });
      expect(first.previousMetadata).not.toHaveProperty("documentation");

      const updated = await patch(ref, { ...changedMetadata(kind), documentation: "New notes" });
      expect(updated.status).toBe(200);
      expect(updated.body.metadata).toEqual({
        ...otherMetadata(kind),
        ...changedMetadata(kind),
        documentation: "New notes",
      });
      expect((await row(ref)).metadata).toEqual(updated.body.metadata);
      const event = await lastEvent(f, ref, "updated");
      expect(event.documentationUndo).toEqual({ present: true, value: "Original notes" });
      expect(event.previousMetadata).toEqual(
        Object.fromEntries(Object.keys(changedMetadata(kind)).map((key) => [key, { present: false }])),
      );
      expect(event.fields).toEqual(["metadata"]);
      expect(event.version).toBe(2);
    });

    it(`PATCH ${kind} without documentation preserves it and records no documentation undo state`, async () => {
      const f = await fixture();
      const ref = { kind, id: f[kind] };
      expect((await patch(ref, { documentation: "Untouched notes" })).status).toBe(200);
      const updated = await patch(ref, otherMetadata(kind));
      expect(updated.status).toBe(200);
      expect(updated.body.metadata).toEqual({ ...otherMetadata(kind), documentation: "Untouched notes" });
      const event = await lastEvent(f, ref, "updated");
      expect(event).not.toHaveProperty("documentationUndo");
      expect(event.previousMetadata).not.toHaveProperty("documentation");
    });

    it(`PATCH ${kind} deletes documentation for null and empty values`, async () => {
      const f = await fixture();
      const ref = { kind, id: f[kind] };
      for (const value of [null, ""]) {
        expect((await patch(ref, { ...otherMetadata(kind), documentation: "Removable notes" })).status).toBe(200);
        const updated = await patch(ref, { documentation: value });
        expect(updated.status).toBe(200);
        expect(updated.body.metadata).toEqual(otherMetadata(kind));
        expect((await row(ref)).metadata).toEqual(otherMetadata(kind));
        const event = await lastEvent(f, ref, "updated");
        expect(event.documentationUndo).toEqual({ present: true, value: "Removable notes" });
        expect(event.previousMetadata).toEqual({});
      }
    });

    it(`PATCH bootstrapped ${kind} rejects documentation atomically but allows other metadata`, async () => {
      const f = await fixture();
      const ref = { kind, id: f[kind] };
      expect((await patch(ref, { ...otherMetadata(kind), documentation: "Canonical notes" })).status).toBe(200);
      await bootstrap(ref, "Canonical notes");
      const before = await row(ref);
      const beforeEvents = await events(f);
      for (const value of ["Rejected notes", null, ""]) {
        const response = await api.request("PATCH", urlFor(ref), owner.session, {
          description: "Must roll back",
          metadata: { ...changedMetadata(kind), documentation: value },
        });
        expect(response.status).toBe(409);
        expect(await row(ref)).toEqual(before);
        expect(await events(f)).toEqual(beforeEvents);
      }
      const allowed = await patch(ref, changedMetadata(kind));
      expect(allowed.status).toBe(200);
      expect(allowed.body.metadata).toEqual({
        ...otherMetadata(kind),
        ...changedMetadata(kind),
        documentation: "Canonical notes",
      });
      expect(await lastEvent(f, ref, "updated")).not.toHaveProperty("documentationUndo");
    });

    for (const bootstrapped of [false, true]) {
      it(`DELETE ${kind} ${bootstrapped ? "omits bootstrapped documentation" : "separates legacy documentation from row snapshots"}`, async () => {
        const f = await fixture();
        const ref = { kind, id: f[kind] };
        expect((await patch(ref, { ...otherMetadata(kind), documentation: "Deletion notes" })).status).toBe(200);
        if (bootstrapped) await bootstrap(ref, "Deletion notes");
        const response = await api.request(
          "DELETE",
          `/api/canvases/${f.canvasId}/${kind === "entity" ? "entities" : "connections"}/${ref.id}`,
          owner.session,
        );
        expect(response.status).toBe(200);
        const event = await lastEvent(f, ref, "deleted");
        const snapshot = kind === "entity" ? (event.snapshot as DeleteSnapshot) : event;
        if (kind === "entity") {
          const entitySnapshot = event.snapshot as DeleteSnapshot;
          for (const entry of [...entitySnapshot.entities, ...entitySnapshot.connections]) {
            expect(entry.metadata).not.toHaveProperty("documentation");
          }
          expect(entitySnapshot.entities.find((entry) => entry.id === ref.id)?.metadata).toEqual(otherMetadata(kind));
        } else {
          expect((event.connection as MetadataRow).metadata).toEqual(otherMetadata(kind));
        }
        if (bootstrapped) expect(snapshot).not.toHaveProperty("documentation");
        else
          expect(snapshot.documentation).toEqual({ [`${kind}:${ref.id}`]: { present: true, value: "Deletion notes" } });
      });
    }
  }

  it("DELETE entity captures legacy subtree and link notes while excluding bootstrapped owners", async () => {
    const f = await fixture();
    const entity: DocumentRef = { kind: "entity", id: f.entity };
    const child: DocumentRef = { kind: "entity", id: f.child };
    const connection: DocumentRef = { kind: "connection", id: f.connection };
    for (const ref of [entity, child, connection]) {
      expect(
        (await patch(ref, { ...otherMetadata(ref.kind), documentation: `${ref.kind}:${ref.id} notes` })).status,
      ).toBe(200);
    }
    await bootstrap(child, `${child.kind}:${child.id} notes`);
    expect(
      (await api.request("DELETE", `/api/canvases/${f.canvasId}/entities/${f.entity}`, owner.session)).status,
    ).toBe(200);
    const event = await lastEvent(f, entity, "deleted");
    const snapshot = event.snapshot as DeleteSnapshot;
    expect(snapshot.entities).toHaveLength(2);
    expect(snapshot.connections).toHaveLength(1);
    for (const entry of [...snapshot.entities, ...snapshot.connections])
      expect(entry.metadata).not.toHaveProperty("documentation");
    expect(snapshot.documentation).toEqual({
      [`entity:${entity.id}`]: { present: true, value: `${entity.kind}:${entity.id} notes` },
      [`connection:${connection.id}`]: { present: true, value: `${connection.kind}:${connection.id} notes` },
    });
  });
});
