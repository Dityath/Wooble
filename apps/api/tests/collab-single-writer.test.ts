import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createCanvasConnectionSchema } from "@wooble/contracts";
import { canvasEvents, canvasNodes, collabDocuments, connections, db, entities } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

// Deliberately independent of the writer implementation: every API request must pass this DB guard.
type Ref = { kind: "entity" | "connection"; id: string };
const api = apiClient();
const kinds = ["entity", "connection"] as const;
const documentOwners: string[] = [];
const insertedEvents: string[] = [];
let owner: Awaited<ReturnType<typeof api.register>>;
let otherOwner: Awaited<ReturnType<typeof api.register>>;

async function removeGuard() {
  for (const table of ["entities", "connections"]) {
    await db.execute(sql`DROP TRIGGER IF EXISTS wooble_test_documentation_guard ON ${sql.identifier(table)}`);
  }
  await db.execute(sql`DROP FUNCTION IF EXISTS wooble_test_documentation_guard()`);
}

beforeEach(() => resetLoginAttempts());
beforeAll(async () => {
  // Replace stale test objects idempotently; no production trigger/function is touched.
  await removeGuard();
  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION wooble_test_documentation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF coalesce(current_setting('wooble.documentation_writer', true), '') <> 'on' THEN
          IF TG_OP = 'INSERT' THEN
            IF NEW.metadata ? 'documentation' THEN
              RAISE EXCEPTION 'wooble_test_documentation_guard rejected INSERT';
            END IF;
          ELSIF (OLD.metadata -> 'documentation') IS DISTINCT FROM (NEW.metadata -> 'documentation') THEN
            RAISE EXCEPTION 'wooble_test_documentation_guard rejected UPDATE';
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `);
    for (const table of ["entities", "connections"]) {
      await db.execute(sql`
        CREATE TRIGGER wooble_test_documentation_guard BEFORE INSERT OR UPDATE ON ${sql.identifier(table)}
        FOR EACH ROW EXECUTE FUNCTION wooble_test_documentation_guard()
      `);
    }
    owner = await api.register("Fictional Single Writer Owner");
    otherOwner = await api.register("Fictional Single Writer Other Workspace");
  } catch (error) {
    await removeGuard();
    throw error;
  }
});

// Bun runs this hook even for failing assertions, so subsequent test files never inherit the guard.
afterAll(async () => {
  try {
    await removeGuard();
  } finally {
    if (documentOwners.length)
      await db.delete(collabDocuments).where(inArray(collabDocuments.objectId, documentOwners));
    if (insertedEvents.length) await db.delete(canvasEvents).where(inArray(canvasEvents.id, insertedEvents));
  }
});

const tableFor = (ref: Ref) => (ref.kind === "entity" ? entities : connections);
const urlFor = (ref: Ref) => `/api/${ref.kind === "entity" ? "entities" : "connections"}/${ref.id}`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const textHash = (text: string | null) => (text === null ? null : digest(text));

async function fixture() {
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Fictional single writer release gate");
  const root = await api.createNode(owner.session, canvasId, { type: "system", name: "Fictional Orders" });
  const childId = await api.createNode(owner.session, canvasId, { name: "Fictional Worker", parentEntityId: root });
  const targetId = await api.createNode(owner.session, canvasId, { name: "Fictional Store" });
  const connectionId = await api.connect(owner.session, canvasId, childId, targetId);
  return {
    canvasId,
    entity: { kind: "entity", id: root } satisfies Ref,
    child: { kind: "entity", id: childId } satisfies Ref,
    connection: { kind: "connection", id: connectionId } satisfies Ref,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function row(ref: Ref) {
  const table = tableFor(ref);
  const [value] = await db.select().from(table).where(eq(table.id, ref.id));
  return value;
}

async function documentationHash(ref: Ref) {
  const table = tableFor(ref);
  const [value] = await db
    .select({ text: sql<string | null>`${table.metadata}->>'documentation'` })
    .from(table)
    .where(eq(table.id, ref.id));
  expect(value).toBeDefined();
  // Keep SQL NULL distinct from the SHA-256 of an empty string.
  return textHash(value.text);
}

async function patch(ref: Ref, documentation: string | null) {
  const response = await api.request("PATCH", urlFor(ref), owner.session, { metadata: { documentation } });
  expect(response.status).toBe(200);
  return response;
}

async function events(f: Fixture) {
  return db.select().from(canvasEvents).where(eq(canvasEvents.canvasId, f.canvasId)).orderBy(desc(canvasEvents.seq));
}

async function undo(f: Fixture, action: string) {
  const result = await api.json("POST", `/api/canvases/${f.canvasId}/undo`, owner.session);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ undone: true, action, skipped: [] });
}

async function bootstrap(ref: Ref, workspaceId = owner.workspaceId) {
  await db.insert(collabDocuments).values({
    workspaceId,
    objectKind: ref.kind,
    objectId: ref.id,
    field: "documentation",
    state: Buffer.from([1, 0, 255]),
    bootstrapVersion: 1,
    mirrorMarkdown: "Mirror text",
    mirrorSha256: digest("Mirror text"),
  });
  documentOwners.push(ref.id);
}

async function record(f: Fixture, ref: Ref, action: "updated" | "deleted", metadata: Record<string, unknown>) {
  // No wall-clock ordering assumptions: only this inserted event is eligible for undo.
  await db.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.canvasId, f.canvasId));
  const [event] = await db
    .insert(canvasEvents)
    .values({
      canvasId: f.canvasId,
      actorUserId: owner.user.id,
      actorName: owner.user.name,
      action: `${ref.kind}.${action}`,
      targetType: ref.kind,
      targetId: ref.id,
      targetName: "Fictional documentation owner",
      metadata,
    })
    .returning({ id: canvasEvents.id });
  insertedEvents.push(event.id);
}

async function remove(f: Fixture, ref: Ref) {
  const response = await api.request(
    "DELETE",
    `/api/canvases/${f.canvasId}/${ref.kind === "entity" ? "entities" : "connections"}/${ref.id}`,
    owner.session,
  );
  expect(response.status).toBe(200);
  expect(await row(ref)).toBeUndefined();
}

describe("single documentation writer release gate", () => {
  for (const kind of kinds) {
    it(`rejects raw ${kind} UPDATE/INSERT but allows a transaction-local writer marker`, async () => {
      const f = await fixture();
      const ref = f[kind];
      const table = tableFor(ref);
      const rawUpdate = sql`UPDATE ${table} SET metadata = metadata || '{"documentation":"x"}'::jsonb WHERE id = ${ref.id}`;
      expect(await documentationHash(ref)).toBeNull();
      await expect(db.transaction(async (tx) => tx.execute(rawUpdate))).rejects.toMatchObject({
        cause: { message: "wooble_test_documentation_guard rejected UPDATE" },
      });
      expect(await documentationHash(ref)).toBeNull();
      // Also prove the INSERT branch really protects restore/create, including a JSON-null key.
      const current = await row(ref);
      expect(current).toBeDefined();
      await expect(
        db.transaction(async (tx) =>
          tx
            .insert(table)
            .values({ ...current, id: crypto.randomUUID(), metadata: sql`'{"documentation":null}'::jsonb` }),
        ),
      ).rejects.toMatchObject({ cause: { message: "wooble_test_documentation_guard rejected INSERT" } });
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('wooble.documentation_writer', 'on', true)`);
        await tx.execute(rawUpdate);
      });
      expect(await documentationHash(ref)).toBe(digest("x"));
      // The marker must not leak to later pool users/transactions.
      await db.execute(rawUpdate); // An identical value is allowed.
      await expect(
        db.transaction(async (tx) =>
          tx.execute(sql`UPDATE ${table} SET metadata = metadata - 'documentation' WHERE id = ${ref.id}`),
        ),
      ).rejects.toMatchObject({ cause: { message: "wooble_test_documentation_guard rejected UPDATE" } });
      expect(await documentationHash(ref)).toBe(digest("x"));
    });

    it(`hashes set, replace, null-delete, empty-delete and unrelated ${kind} PATCH writes`, async () => {
      const f = await fixture();
      const ref = f[kind];
      expect(await documentationHash(ref)).toBeNull();
      const retained = kind === "entity" ? { language: "TypeScript" } : { contract: "Fictional REST contract" };
      expect((await api.request("PATCH", urlFor(ref), owner.session, { metadata: retained })).status).toBe(200);
      expect(await documentationHash(ref)).toBeNull();
      for (const value of ["Initial notes", "Replacement notes", null, "Removable notes", ""]) {
        await patch(ref, value);
        expect(await documentationHash(ref)).toBe(textHash(value === "" ? null : value));
        expect(Object.hasOwn((await row(ref)).metadata, "documentation")).toBe(value !== null && value !== "");
        expect((await row(ref)).metadata).toMatchObject(retained);
      }
      await patch(ref, "Retained notes");
      const before = await documentationHash(ref);
      const metadata = kind === "entity" ? { framework: "Fictional framework" } : { direction: "two-way" };
      const response = await api.request("PATCH", urlFor(ref), owner.session, { metadata });
      expect(response.status).toBe(200);
      expect(await documentationHash(ref)).toBe(before);
      expect((await row(ref)).metadata).toMatchObject(metadata);
      expect((await row(ref)).metadata).toMatchObject(retained);
    });

    it(`hashes ${kind}.updated undo through the registered routes`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await patch(ref, "Previous notes");
      expect(await documentationHash(ref)).toBe(digest("Previous notes"));
      await patch(ref, "Current notes");
      expect(await documentationHash(ref)).toBe(digest("Current notes"));
      await undo(f, `${kind}.updated`);
      expect(await documentationHash(ref)).toBe(digest("Previous notes"));
    });

    for (const format of ["v2", "pre-v2"] as const) {
      it(`hashes ${kind} undo of directly inserted ${format} documentation history`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await patch(ref, "Current history notes");
        expect(await documentationHash(ref)).toBe(digest("Current history notes"));
        await record(
          f,
          ref,
          "updated",
          format === "v2"
            ? {
                version: 2,
                fields: ["metadata"],
                previous: {},
                previousMetadata: { documentation: { present: true, value: "Old history notes" } },
              }
            : { fields: ["metadata"], previous: { metadata: { documentation: "Old history notes" } } },
        );
        await undo(f, `${kind}.updated`);
        expect(await documentationHash(ref)).toBe(digest("Old history notes"));
      });
    }

    it(`rejects bootstrapped ${kind} documentation PATCH atomically and permits a rename`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await patch(ref, "Mirror text");
      await bootstrap(ref);
      const beforeHash = await documentationHash(ref);
      const beforeRow = await row(ref);
      const beforeEvents = await events(f);
      for (const value of ["Rejected notes", null, ""]) {
        const response = await api.request("PATCH", urlFor(ref), owner.session, {
          description: "Should roll back",
          metadata: { documentation: value },
        });
        expect(response.status).toBe(409);
        expect(await documentationHash(ref)).toBe(beforeHash);
        expect(await row(ref)).toEqual(beforeRow);
        expect(await events(f)).toEqual(beforeEvents);
      }
      const rename = kind === "entity" ? { name: "Renamed fictional system" } : { label: "Renamed fictional link" };
      expect((await api.request("PATCH", urlFor(ref), owner.session, rename)).status).toBe(200);
      expect(await row(ref)).toMatchObject(rename);
      expect(await documentationHash(ref)).toBe(beforeHash);
    });

    it(`undoes a pre-bootstrap ${kind} edit using the mirror instead of old text`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await patch(ref, "Old pre-bootstrap text");
      await db.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.canvasId, f.canvasId));
      await patch(ref, "Latest legacy text");
      expect(await documentationHash(ref)).toBe(digest("Latest legacy text"));
      await bootstrap(ref);
      const response = await api.request("POST", `/api/canvases/${f.canvasId}/undo`, owner.session);
      expect(response.status).toBe(200);
      expect(await documentationHash(ref)).toBe(digest("Mirror text"));
    });

    it(`fails closed on a ${kind} document workspace mismatch`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await patch(ref, "Owner workspace notes");
      const beforeHash = await documentationHash(ref);
      const beforeRow = await row(ref);
      const beforeEvents = await events(f);
      await bootstrap(ref, otherOwner.workspaceId);
      const response = await api.request("PATCH", urlFor(ref), owner.session, {
        description: "Should roll back",
        metadata: { documentation: "Rejected workspace notes" },
      });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
      expect(await documentationHash(ref)).toBe(beforeHash);
      expect(await row(ref)).toEqual(beforeRow);
      expect(await events(f)).toEqual(beforeEvents);
    });
  }

  it("creates connections without a documentation key as required by the create contract", async () => {
    // This contract has no metadata input; fixture's connection is created by the real API.
    expect(createCanvasConnectionSchema.innerType().shape).not.toHaveProperty("metadata");
    const f = await fixture();
    expect(await documentationHash(f.connection)).toBeNull();
    expect((await row(f.connection)).metadata).not.toHaveProperty("documentation");
    expect(await documentationHash(f.entity)).toBeNull();
    expect(await documentationHash(f.child)).toBeNull();
  });

  for (const kind of kinds) {
    for (const bootstrapped of [false, true]) {
      it(`hashes ${kind} DELETE/undo for ${bootstrapped ? "bootstrapped" : "legacy"} documents`, async () => {
        const f = await fixture();
        const ref = f[kind];
        const refs = kind === "entity" ? [f.entity, f.child, f.connection] : [f.connection];
        const before = new Map<string, string | null>();
        for (const entry of refs) {
          await patch(entry, `Pre-bootstrap documentation ${entry.id}`);
          before.set(entry.id, await documentationHash(entry));
          expect(before.get(entry.id)).toBe(digest(`Pre-bootstrap documentation ${entry.id}`));
          if (bootstrapped) await bootstrap(entry);
        }
        await remove(f, ref);
        for (const entry of refs) expect(await row(entry)).toBeUndefined();
        if (bootstrapped) {
          const [event] = await db
            .select({ json: sql<string>`${canvasEvents.metadata}::text` })
            .from(canvasEvents)
            .where(and(eq(canvasEvents.canvasId, f.canvasId), eq(canvasEvents.action, `${kind}.deleted`)))
            .orderBy(desc(canvasEvents.seq))
            .limit(1);
          expect(event).toBeDefined();
          for (const entry of refs) expect(event.json).not.toContain(`Pre-bootstrap documentation ${entry.id}`);
        }
        await undo(f, `${kind}.deleted`);
        for (const entry of refs) {
          expect(await documentationHash(entry)).toBe(
            bootstrapped ? digest("Mirror text") : (before.get(entry.id) ?? null),
          );
        }
        const graph = await api.json<{ entities: Array<{ id: string }>; connections: Array<{ id: string }> }>(
          "GET",
          `/api/canvases/${f.canvasId}/graph`,
          owner.session,
        );
        expect(graph.status).toBe(200);
        expect(graph.body.entities.map((entry) => entry.id)).toContain(f.child.id);
        expect(graph.body.connections.map((entry) => entry.id)).toContain(f.connection.id);
      });
    }

    it(`restores old-format ${kind}.deleted row snapshots containing documentation through the writer`, async () => {
      const f = await fixture();
      const ref = f[kind];
      const refs = kind === "entity" ? [f.entity, f.child, f.connection] : [f.connection];
      for (const entry of refs) {
        await patch(entry, `Old snapshot ${entry.id}`);
        expect(await documentationHash(entry)).toBe(digest(`Old snapshot ${entry.id}`));
      }
      const entityRows = await db
        .select({
          id: entities.id,
          workspaceId: entities.workspaceId,
          type: entities.type,
          name: entities.name,
          description: entities.description,
          metadata: entities.metadata,
        })
        .from(entities)
        .where(inArray(entities.id, [f.entity.id, f.child.id]));
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
      const placements = await db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, f.canvasId));
      const snapshotConnection = { ...connection, bend: null };
      // Simulate historical deletion without invoking today's snapshot writer.
      if (kind === "entity") await db.delete(entities).where(inArray(entities.id, [f.entity.id, f.child.id]));
      else await db.delete(connections).where(eq(connections.id, f.connection.id));
      for (const entry of refs) expect(await row(entry)).toBeUndefined();
      await record(
        f,
        ref,
        "deleted",
        kind === "entity"
          ? { snapshot: { entities: entityRows, connections: [snapshotConnection], placements } }
          : { connection: snapshotConnection },
      );
      await undo(f, `${kind}.deleted`);
      for (const entry of refs) expect(await documentationHash(entry)).toBe(digest(`Old snapshot ${entry.id}`));
    });
  }

  it("keeps the development seed free of documentation keys", async () => {
    const source = await readFile(new URL("../../../packages/db/src/seed.ts", import.meta.url), "utf8");
    expect(source).not.toContain("documentation");
  });
});
