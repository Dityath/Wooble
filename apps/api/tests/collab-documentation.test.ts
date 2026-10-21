import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { canvases, collabDocuments, connections, db, entities, pool } from "@wooble/db";
import * as schema from "../../../packages/db/src/schema";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { createApp } from "../src/app";
import type { PreviousMetadataEntry } from "../src/modules/canvas/event-metadata";
import { isExternalMetadataKey, type Transaction } from "../src/modules/canvas/undo-registry";
import {
  CollaborativeDocumentationConflict,
  DOCUMENTATION_KEY,
  DOCUMENTATION_SNAPSHOT_KEY,
  DOCUMENTATION_UNDO_KEY,
  DOCUMENTATION_WRITER_SETTING,
  DocumentWorkspaceMismatch,
  type DocumentRef,
  documentationRestoreWouldChange,
  documentationUndoEntry,
  isBootstrapped,
  registerCollabDocumentation,
  reprojectMirror,
  restoreDocumentation,
  restoreDocumentations,
  snapshotDocumentation,
  withoutDocumentation,
  writeDocumentation,
} from "../src/modules/collab/documentation";
import { apiClient } from "./support/client";

const api = apiClient();
let owner: Awaited<ReturnType<typeof api.register>>;
let otherOwner: Awaited<ReturnType<typeof api.register>>;
beforeEach(() => resetLoginAttempts());
beforeAll(async () => {
  owner = await api.register("Documentation Owner");
  otherOwner = await api.register("Other Documentation Owner");
});

async function fixture() {
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Documentation tests");
  const source = await api.createNode(owner.session, canvasId, { name: "Fictional Orders" });
  const target = await api.createNode(owner.session, canvasId, { name: "Fictional Storage" });
  const connectionId = await api.connect(owner.session, canvasId, source, target);
  const entity: DocumentRef = { kind: "entity", id: source };
  const connection: DocumentRef = { kind: "connection", id: connectionId };
  return { canvasId, entity, connection, refs: [entity, connection] };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const tableFor = (ref: DocumentRef) => (ref.kind === "entity" ? entities : connections);

async function locked<T>(f: Fixture, callback: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockFixture(tx, f);
    return callback(tx);
  });
}

async function lockFixture(tx: Transaction, f: Fixture): Promise<void> {
  await tx.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, f.canvasId)).for("update");
  for (const ref of [...f.refs].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    const table = tableFor(ref);
    await tx.select({ id: table.id }).from(table).where(eq(table.id, ref.id)).for("update");
  }
}

/** Observe the actual connection, including query-builder statements, excluding caller locks and BEGIN/COMMIT. */
async function counted<T>(f: Fixture, callback: (tx: Transaction) => Promise<T>) {
  const client = await pool.connect();
  try {
    return await drizzle(client, { schema }).transaction(async (tx) => {
      await lockFixture(tx, f);
      const querySpy = spyOn(client, "query");
      try {
        const result = await callback(tx);
        const statements = querySpy.mock.calls.map(([query]) => {
          // pg's overload inferred by spyOn is string-only, but Drizzle also passes query configs.
          const input: unknown = query;
          if (typeof input === "string") return input;
          if (typeof input === "object" && input !== null && "text" in input && typeof input.text === "string") {
            return input.text;
          }
          throw new Error("Unexpected PostgreSQL query argument");
        });
        return { result, statements };
      } finally {
        querySpy.mockRestore();
      }
    });
  } finally {
    client.release();
  }
}

async function manyOwners() {
  const f = await fixture();
  const entityRows = await db
    .insert(entities)
    .values(
      Array.from({ length: 50 }, (_, index) => ({
        workspaceId: owner.workspaceId,
        type: "service" as const,
        name: `Fictional batch service ${index}`,
        // Include historical JSON null, which the current domain input type no longer accepts.
        metadata: sql`${JSON.stringify(index % 3 === 0 ? { retained: index } : { retained: index, documentation: index % 2 ? "Notes" : null })}::jsonb`,
      })),
    )
    .returning({ id: entities.id, metadata: entities.metadata });
  const connectionRows = await db
    .insert(connections)
    .values(
      Array.from({ length: 10 }, (_, index) => ({
        workspaceId: owner.workspaceId,
        sourceEntityId: f.entity.id,
        targetEntityId: entityRows[index].id,
        type: "rest" as const,
        label: "Fictional batch link",
        metadata: index % 2 ? { retained: index, documentation: "" } : { retained: index },
      })),
    )
    .returning({ id: connections.id, metadata: connections.metadata });
  const rows = [
    ...entityRows.map((row) => ({ ...row, ref: { kind: "entity" as const, id: row.id } })),
    ...connectionRows.map((row) => ({ ...row, ref: { kind: "connection" as const, id: row.id } })),
  ];
  return { ...f, refs: rows.map((row) => row.ref), rows };
}

async function rowVersions(tx: Transaction, refs: DocumentRef[]) {
  const versions: Record<string, string> = {};
  for (const kind of ["entity", "connection"] as const) {
    const table = tableFor({ kind, id: "" });
    const ids = refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    const rows = await tx
      .select({ id: table.id, xmin: sql<string>`xmin::text` })
      .from(table)
      .where(sql`${table.id} = ANY(${sql.param(ids)}::uuid[])`);
    for (const row of rows) versions[`${kind}:${row.id}`] = row.xmin;
  }
  return versions;
}

async function metadata(tx: Transaction, ref: DocumentRef): Promise<Record<string, unknown>> {
  const table = tableFor(ref);
  const [row] = await tx.select({ metadata: table.metadata }).from(table).where(eq(table.id, ref.id));
  return row.metadata;
}

async function allMetadata(tx: Transaction, refs: DocumentRef[]): Promise<Record<string, unknown>[]> {
  const result = [];
  for (const ref of refs) result.push(await metadata(tx, ref));
  return result;
}

async function bootstrap(
  ref: DocumentRef,
  mirror: string,
  overrides: Partial<typeof collabDocuments.$inferInsert> = {},
) {
  await db.insert(collabDocuments).values({
    workspaceId: owner.workspaceId,
    objectKind: ref.kind,
    objectId: ref.id,
    field: DOCUMENTATION_KEY,
    state: Buffer.from([1, 0, 255]),
    bootstrapVersion: 1,
    mirrorMarkdown: mirror,
    mirrorSha256: createHash("sha256").update(mirror).digest("hex"),
    ...overrides,
  });
}

/** Transaction-scoped triggers: reject unmarked writers and count even no-op UPDATEs. */
async function guarded<T>(tx: Transaction, callback: () => Promise<T>): Promise<T> {
  await tx.execute(sql`
    CREATE OR REPLACE FUNCTION pg_temp.t2_documentation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (OLD.metadata -> 'documentation') IS DISTINCT FROM (NEW.metadata -> 'documentation')
        AND current_setting('wooble.documentation_writer', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Documentation writer guard rejected update';
      END IF;
      PERFORM set_config('wooble_test.documentation_updates',
        (coalesce(nullif(current_setting('wooble_test.documentation_updates', true), ''), '0')::int + 1)::text,
        true);
      RETURN NEW;
    END $$
  `);
  for (const table of ["entities", "connections"]) {
    await tx.execute(sql`
      CREATE TRIGGER t2_documentation_guard BEFORE UPDATE OF metadata ON ${sql.identifier(table)}
      FOR EACH ROW EXECUTE FUNCTION pg_temp.t2_documentation_guard()
    `);
  }
  try {
    return await callback();
  } finally {
    for (const table of ["entities", "connections"]) {
      await tx.execute(sql`DROP TRIGGER t2_documentation_guard ON ${sql.identifier(table)}`);
    }
  }
}

async function updateCount(tx: Transaction): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    SELECT coalesce(nullif(current_setting('wooble_test.documentation_updates', true), ''), '0')::int AS count
  `);
  return result.rows[0].count;
}

async function expectWriterOff(tx: Transaction): Promise<void> {
  const result = await tx.execute<{ setting: string | null }>(sql`
    SELECT current_setting(${DOCUMENTATION_WRITER_SETTING}, true) AS setting
  `);
  expect([null, "", "off"]).toContain(result.rows[0].setting);
}

describe("documentation persistence", () => {
  for (const kind of ["entity", "connection"] as const) {
    it(`sets, replaces and deletes legacy ${kind} documentation with accurate previous state`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await locked(f, async (tx) => {
        const table = tableFor(ref);
        // Represents other metadata written by the caller earlier in this same transaction.
        await tx
          .update(table)
          .set({ metadata: sql`${JSON.stringify({ retained: "caller value" })}::jsonb` })
          .where(eq(table.id, ref.id));
        const [before] = await tx
          .select({ updatedAt: entities.updatedAt })
          .from(entities)
          .where(eq(entities.id, f.entity.id));
        await guarded(tx, async () => {
          expect(await writeDocumentation(tx, ref, "First notes")).toEqual({
            previous: { present: false },
            changed: true,
          });
          expect(await metadata(tx, ref)).toEqual({ retained: "caller value", documentation: "First notes" });
          await expectWriterOff(tx);
          const count = await updateCount(tx);
          expect(await writeDocumentation(tx, ref, "First notes")).toEqual({
            previous: { present: true, value: "First notes" },
            changed: false,
          });
          expect(await updateCount(tx)).toBe(count);
          expect(await writeDocumentation(tx, ref, "Replacement")).toEqual({
            previous: { present: true, value: "First notes" },
            changed: true,
          });
          expect(await writeDocumentation(tx, ref, null)).toEqual({
            previous: { present: true, value: "Replacement" },
            changed: true,
          });
          expect(await writeDocumentation(tx, ref, "")).toEqual({ previous: { present: false }, changed: false });
          expect(await updateCount(tx)).toBe(count + 2);
          await writeDocumentation(tx, ref, "Delete with empty string");
          expect(await writeDocumentation(tx, ref, "")).toEqual({
            previous: { present: true, value: "Delete with empty string" },
            changed: true,
          });
          expect(await metadata(tx, ref)).toEqual({ retained: "caller value" });
          await expectWriterOff(tx);
          // A direct writer is rejected; a savepoint keeps this transaction usable.
          await expect(
            tx.transaction(async (savepoint) => {
              await savepoint
                .update(table)
                .set({ metadata: { documentation: "Unmarked" } })
                .where(eq(table.id, ref.id));
            }),
          ).rejects.toMatchObject({ cause: { message: "Documentation writer guard rejected update" } });
          await expectWriterOff(tx);
        });
        const [after] = await tx
          .select({ updatedAt: entities.updatedAt })
          .from(entities)
          .where(eq(entities.id, f.entity.id));
        expect(after.updatedAt).toEqual(before.updatedAt);
      });
    });

    it(`refuses legacy writes to bootstrapped ${kind} documents, including tombstoned rows`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await locked(f, (tx) => writeDocumentation(tx, ref, "Existing notes"));
      await bootstrap(ref, "Collaborative mirror", { deletedAt: new Date(), state: Buffer.alloc(0) });
      for (const value of ["Rejected replacement", null, ""]) {
        await expect(locked(f, (tx) => writeDocumentation(tx, ref, value))).rejects.toBeInstanceOf(
          CollaborativeDocumentationConflict,
        );
      }
      await locked(f, async (tx) => {
        expect(await isBootstrapped(tx, ref)).toBe(true);
        expect(await isBootstrapped(tx, ref, true)).toBe(true);
        expect(await metadata(tx, ref)).toEqual({ documentation: "Existing notes" });
      });
      const error = new CollaborativeDocumentationConflict();
      expect(error.status).toBe(409);
      expect(error.message).not.toContain("Collaborative mirror");
    });

    it(`restores legacy ${kind} entries including JSON null and treats placeholders as legacy`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await locked(f, async (tx) => {
        expect(await isBootstrapped(tx, ref)).toBe(false);
        expect(await reprojectMirror(tx, ref)).toBe(false);
      });
      // Even a bootstrap_version and mirror without state are a placeholder.
      await bootstrap(ref, "Unused placeholder mirror", { state: null });
      await locked(f, (tx) =>
        guarded(tx, async () => {
          expect(await isBootstrapped(tx, ref, true)).toBe(false);
          expect(await reprojectMirror(tx, ref)).toBe(false);
          expect(await restoreDocumentation(tx, ref, undefined)).toBe(false);
          expect(await restoreDocumentation(tx, ref, { present: false })).toBe(false);
          expect(await updateCount(tx)).toBe(0);
          expect(await restoreDocumentation(tx, ref, { present: true, value: "Old notes" })).toBe(true);
          expect(await restoreDocumentation(tx, ref, undefined)).toBe(false);
          expect(await metadata(tx, ref)).toEqual({ documentation: "Old notes" });
          expect(await restoreDocumentation(tx, ref, { present: true, value: null })).toBe(true);
          expect(await metadata(tx, ref)).toEqual({ documentation: null });
          expect(await writeDocumentation(tx, ref, "Legacy edit")).toEqual({
            previous: { present: true, value: null },
            changed: true,
          });
          expect(await restoreDocumentation(tx, ref, { present: false })).toBe(true);
          expect(await metadata(tx, ref)).toEqual({});
          expect(await restoreDocumentation(tx, ref, { present: true, value: "" })).toBe(true);
          expect(await metadata(tx, ref)).toEqual({ documentation: "" });
          await expectWriterOff(tx);
        }),
      );
    });

    it(`reprojects bootstrapped ${kind} mirrors regardless of undo entry`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await bootstrap(ref, "Canonical mirror");
      const entries: Array<PreviousMetadataEntry | undefined> = [
        undefined,
        { present: false },
        { present: true, value: "Old text" },
      ];
      for (const entry of entries) {
        await locked(f, async (tx) => {
          const table = tableFor(ref);
          await tx
            .update(table)
            .set({ metadata: sql`${JSON.stringify({ retained: true, documentation: "Stale projection" })}::jsonb` })
            .where(eq(table.id, ref.id));
          await guarded(tx, async () => {
            expect(await restoreDocumentation(tx, ref, entry)).toBe(true);
            expect(await metadata(tx, ref)).toEqual({ retained: true, documentation: "Canonical mirror" });
            expect(await reprojectMirror(tx, ref)).toBe(false);
            expect(await updateCount(tx)).toBe(1);
            await expectWriterOff(tx);
          });
        });
      }
      await db
        .update(collabDocuments)
        .set({ mirrorMarkdown: "", mirrorSha256: createHash("sha256").update("").digest("hex") })
        .where(eq(collabDocuments.objectId, ref.id));
      await locked(f, (tx) =>
        guarded(tx, async () => {
          expect(await reprojectMirror(tx, ref)).toBe(true);
          expect(await metadata(tx, ref)).toEqual({ retained: true });
        }),
      );
    });

    for (const mirror of ["Canonical mirror", ""]) {
      it(`predicts ${kind} restore writes from a ${mirror === "" ? "blank" : "nonblank"} bootstrapped mirror`, async () => {
        const f = await fixture();
        const ref = f[kind];
        await locked(f, (tx) => writeDocumentation(tx, ref, "Stale projection"));
        await bootstrap(ref, mirror);
        await locked(f, (tx) =>
          guarded(tx, async () => {
            const entries: Array<PreviousMetadataEntry | undefined> = [
              undefined,
              { present: false },
              { present: true, value: "Stale projection" },
            ];
            for (const entry of entries) {
              expect(await documentationRestoreWouldChange(tx, ref, entry)).toBe(true);
            }
            expect(await updateCount(tx)).toBe(0);
            expect(await metadata(tx, ref)).toEqual({ documentation: "Stale projection" });
            expect(await restoreDocumentation(tx, ref, undefined)).toBe(true);
            expect(await metadata(tx, ref)).toEqual(mirror === "" ? {} : { documentation: mirror });
            for (const entry of entries) {
              expect(await documentationRestoreWouldChange(tx, ref, entry)).toBe(false);
              expect(await restoreDocumentation(tx, ref, entry)).toBe(false);
            }
            expect(await updateCount(tx)).toBe(1);
            await expectWriterOff(tx);
          }),
        );
      });
    }

    it(`predicts legacy ${kind} restore writes from entry presence and deep equality`, async () => {
      const f = await fixture();
      const ref = f[kind];
      // An unbootstrapped placeholder must not make its mirror authoritative.
      await bootstrap(ref, "Unused placeholder mirror", { state: null });
      await locked(f, (tx) =>
        guarded(tx, async () => {
          const cases: Array<{ entry: PreviousMetadataEntry | undefined; changed: boolean }> = [
            { entry: undefined, changed: false },
            { entry: { present: false }, changed: false },
            { entry: { present: true, value: null }, changed: true },
            { entry: { present: true, value: null }, changed: false },
            { entry: { present: true, value: { a: 1, b: [2] } }, changed: true },
            { entry: { present: true, value: { b: [2], a: 1 } }, changed: false },
            { entry: { present: true, value: "Legacy notes" }, changed: true },
            { entry: { present: true, value: "Legacy notes" }, changed: false },
            { entry: undefined, changed: false },
            { entry: { present: false }, changed: true },
            { entry: { present: false }, changed: false },
          ];
          for (const { entry, changed } of cases) {
            const count = await updateCount(tx);
            const before = await metadata(tx, ref);
            expect(await documentationRestoreWouldChange(tx, ref, entry)).toBe(changed);
            expect(await updateCount(tx)).toBe(count);
            expect(await metadata(tx, ref)).toEqual(before);
            expect(await restoreDocumentation(tx, ref, entry)).toBe(changed);
            expect(await updateCount(tx)).toBe(count + Number(changed));
          }
          await expectWriterOff(tx);
        }),
      );
    });

    it(`fails closed for a ${kind} workspace mismatch and rolls back caller writes`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await bootstrap(ref, "Private mirror", { workspaceId: otherOwner.workspaceId });
      const actions = [
        (tx: Transaction) => writeDocumentation(tx, ref, "Private replacement"),
        (tx: Transaction) => restoreDocumentation(tx, ref, undefined),
        (tx: Transaction) =>
          restoreDocumentations(
            tx,
            f.refs.map((ownerRef) => ({ ref: ownerRef, entry: { present: true, value: "Undo" } })),
          ),
        (tx: Transaction) => documentationRestoreWouldChange(tx, ref, undefined),
        (tx: Transaction) => reprojectMirror(tx, ref),
        (tx: Transaction) => isBootstrapped(tx, ref),
        (tx: Transaction) => snapshotDocumentation(tx, [ref]),
      ];
      for (const action of actions) {
        await expect(
          locked(f, async (tx) => {
            const table = tableFor(ref);
            await tx
              .update(table)
              .set({ metadata: sql`${JSON.stringify({ retained: "Should roll back" })}::jsonb` })
              .where(eq(table.id, ref.id));
            return action(tx);
          }),
        ).rejects.toBeInstanceOf(DocumentWorkspaceMismatch);
      }
      await locked(f, async (tx) => expect(await metadata(tx, ref)).toEqual({}));
      const error = new DocumentWorkspaceMismatch(ref, owner.workspaceId, otherOwner.workspaceId);
      expect(error.status).toBe(500);
      expect(error.message).toContain(ref.id);
      expect(error.message).not.toContain("Private mirror");
      expect(error.message).not.toContain("Private replacement");
    });
  }

  it("captures only legacy documentation present on owners", async () => {
    const f = await fixture();
    await locked(f, async (tx) => {
      expect(await snapshotDocumentation(tx, f.refs)).toEqual({});
      await writeDocumentation(tx, f.entity, "Legacy entity notes");
      await restoreDocumentation(tx, f.connection, { present: true, value: null });
      expect(await snapshotDocumentation(tx, f.refs)).toEqual({
        [`entity:${f.entity.id}`]: { present: true, value: "Legacy entity notes" },
        [`connection:${f.connection.id}`]: { present: true, value: null },
      });
    });
    await bootstrap(f.entity, "Collaborative notes");
    await bootstrap(f.connection, "Unused placeholder", { state: null, bootstrapVersion: null });
    await locked(f, async (tx) => {
      expect(await snapshotDocumentation(tx, [...f.refs, { kind: "entity", id: crypto.randomUUID() }])).toEqual({
        [`connection:${f.connection.id}`]: { present: true, value: null },
      });
    });
    expect(DOCUMENTATION_SNAPSHOT_KEY).toBe("documentation");
  });

  it("snapshots 50 entities and 10 connections in three queries with legacy presence semantics", async () => {
    const f = await manyOwners();
    const collaborative = f.refs[1];
    await bootstrap(collaborative, "Canonical mirror");
    await bootstrap(f.refs[2], "Placeholder mirror", { state: null });
    const missing: DocumentRef = { kind: "entity", id: crypto.randomUUID() };
    await bootstrap(missing, "Orphan mirror", { workspaceId: otherOwner.workspaceId });
    const expected: Record<string, PreviousMetadataEntry> = {};
    for (const { ref, metadata } of f.rows) {
      if (ref === collaborative || !Object.hasOwn(metadata, DOCUMENTATION_KEY)) continue;
      expected[`${ref.kind}:${ref.id}`] = { present: true, value: metadata.documentation };
    }
    const { result, statements } = await counted(f, (tx) => snapshotDocumentation(tx, [...f.refs, missing]));
    expect(result).toEqual(expected);
    expect(statements).toHaveLength(3);
    expect(statements.every((statement) => /^select /i.test(statement))).toBe(true);
    expect(statements.some((statement) => /for update|for share|for key share/i.test(statement))).toBe(false);
    expect((await counted(f, (tx) => snapshotDocumentation(tx, []))).statements).toHaveLength(0);
  });

  it("matches uppercase UUID refs while preserving the snapshot's caller-supplied keys", async () => {
    const f = await fixture();
    const uppercase = f.refs.map((ref) => ({ ...ref, id: ref.id.toUpperCase() }));
    await locked(f, async (tx) => {
      for (const ref of uppercase) {
        expect(await restoreDocumentation(tx, ref, { present: true, value: "Legacy notes" })).toBe(true);
      }
      expect(await snapshotDocumentation(tx, uppercase)).toEqual(
        Object.fromEntries(uppercase.map((ref) => [`${ref.kind}:${ref.id}`, { present: true, value: "Legacy notes" }])),
      );
      await restoreDocumentations(
        tx,
        uppercase.map((ref) => ({ ref, entry: { present: true, value: null } })),
      );
      expect(await allMetadata(tx, f.refs)).toEqual([{ documentation: null }, { documentation: null }]);
    });
    await bootstrap(f.entity, "Canonical mirror");
    await locked(f, async (tx) => {
      await restoreDocumentations(
        tx,
        uppercase.map((ref) => ({ ref, entry: undefined })),
      );
      expect(await metadata(tx, f.entity)).toEqual({ documentation: "Canonical mirror" });
      expect(await snapshotDocumentation(tx, uppercase)).toEqual({
        [`connection:${uppercase[1].id}`]: { present: true, value: null },
      });
    });
  });

  it("batch restore matches sequential restore, locks collab rows in order and skips unchanged owners", async () => {
    const f = await manyOwners();
    await bootstrap(f.refs[0], "Canonical mirror");
    await bootstrap(f.refs[51], "");
    await bootstrap(f.refs[2], "Unused placeholder", { state: null });
    const items = f.refs.map((ref, index) => ({
      ref,
      entry: [undefined, { present: false }, { present: true, value: null }, { present: true, value: "Restored" }][
        index % 4
      ] as PreviousMetadataEntry | undefined,
    }));
    items.push({ ref: { kind: "connection", id: crypto.randomUUID() }, entry: { present: true, value: "Missing" } });
    let expected: Record<string, unknown>[] = [];
    const rollback = new Error("Rollback reference restores");
    await expect(
      locked(f, async (tx) => {
        for (const { ref, entry } of items) await restoreDocumentation(tx, ref, entry);
        expected = await allMetadata(tx, f.refs);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const before = await locked(f, (tx) => rowVersions(tx, f.refs));
    // Deliberately reverse snapshot order; the collab lock query must still impose its own order.
    const { statements } = await counted(f, (tx) => restoreDocumentations(tx, [...items].reverse()));
    const updates = statements.filter((statement) => /^update /i.test(statement));
    expect(updates.length).toBeGreaterThan(0);
    expect(statements).toHaveLength(3 + 2 + updates.length);
    expect(statements.filter((statement) => /set_config/.test(statement))).toHaveLength(2);
    const collabQueries = statements.filter((statement) => /from "collab_documents"/.test(statement));
    expect(collabQueries).toHaveLength(1);
    expect(collabQueries[0]).toMatch(
      /order by "collab_documents"\."object_kind" asc, "collab_documents"\."object_id" asc for update$/,
    );
    await locked(f, async (tx) => {
      expect(await allMetadata(tx, f.refs)).toEqual(expected);
      const after = await rowVersions(tx, f.refs);
      expect(Object.keys(after).filter((key) => after[key] !== before[key])).toHaveLength(updates.length);
      for (let index = 0; index < f.rows.length; index++) {
        if (JSON.stringify(f.rows[index].metadata) === JSON.stringify(expected[index])) {
          const { ref } = f.rows[index];
          expect(after[`${ref.kind}:${ref.id}`]).toBe(before[`${ref.kind}:${ref.id}`]);
        }
      }
      await expectWriterOff(tx);
    });
    const settled = await locked(f, (tx) => rowVersions(tx, f.refs));
    const noOp = await counted(f, (tx) => restoreDocumentations(tx, items));
    expect(noOp.statements).toHaveLength(3);
    expect(noOp.statements.every((statement) => /^select /i.test(statement))).toBe(true);
    expect(await locked(f, (tx) => rowVersions(tx, f.refs))).toEqual(settled);
    expect((await counted(f, (tx) => restoreDocumentations(tx, []))).statements).toHaveLength(0);
  });

  it("preserves the original UPDATE error in single writes and batch restores", async () => {
    const f = await fixture();
    // A temporary function and a trigger scoped to this scratch owner; clean both on the same connection.
    const client = await pool.connect();
    const database = drizzle(client, { schema });
    const trigger = `wooble_test_documentation_failure_${f.entity.id.replaceAll("-", "")}`;
    try {
      await database.execute(sql`
        CREATE FUNCTION pg_temp.wooble_test_documentation_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'boom-original';
        END $$
      `);
      await database.execute(sql`
        CREATE TRIGGER ${sql.identifier(trigger)} BEFORE UPDATE OF metadata ON entities
        FOR EACH ROW WHEN (OLD.id = ${sql.raw(`'${f.entity.id}'::uuid`)})
        EXECUTE FUNCTION pg_temp.wooble_test_documentation_failure()
      `);
      const actions = [
        (tx: Transaction) => writeDocumentation(tx, f.entity, "Trigger failure"),
        (tx: Transaction) => restoreDocumentations(tx, [{ ref: f.entity, entry: { present: true, value: "Failure" } }]),
      ];
      for (const action of actions) {
        let failure: unknown;
        try {
          await database.transaction(async (tx) => {
            await lockFixture(tx, f);
            await action(tx);
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ cause: { message: "boom-original" } });
        const error = failure as Error & { cause: Error };
        expect(`${error.message} ${error.cause.message}`).not.toContain("current transaction is aborted");
      }
    } finally {
      await database.execute(sql`DROP TRIGGER IF EXISTS ${sql.identifier(trigger)} ON entities`);
      await database.execute(sql`DROP FUNCTION IF EXISTS pg_temp.wooble_test_documentation_failure()`);
      client.release();
    }
  });

  it("throws for a missing write owner and skips missing restore/read owners", async () => {
    const f = await fixture();
    for (const kind of ["entity", "connection"] as const) {
      const ref: DocumentRef = { kind, id: crypto.randomUUID() };
      await expect(locked(f, (tx) => writeDocumentation(tx, ref, "Missing"))).rejects.toThrow(
        "Documentation owner not found",
      );
      await locked(f, async (tx) => {
        expect(await documentationRestoreWouldChange(tx, ref, undefined)).toBe(false);
        expect(await documentationRestoreWouldChange(tx, ref, { present: true, value: "Missing" })).toBe(false);
        expect(await restoreDocumentation(tx, ref, { present: true, value: "Missing" })).toBe(false);
        expect(await reprojectMirror(tx, ref)).toBe(false);
        expect(await isBootstrapped(tx, ref)).toBe(false);
      });
    }
  });
});

describe("documentation history helpers", () => {
  it("reads all three undo formats with newest-format precedence", () => {
    expect(
      documentationUndoEntry({
        [DOCUMENTATION_UNDO_KEY]: { present: false },
        previousMetadata: { documentation: { present: true, value: "v2" } },
        previous: { metadata: { documentation: "pre-v2" } },
      }),
    ).toEqual({ present: false });
    expect(documentationUndoEntry({ [DOCUMENTATION_UNDO_KEY]: { present: true, value: null } })).toEqual({
      present: true,
      value: null,
    });
    expect(
      documentationUndoEntry({
        version: 2,
        previousMetadata: { documentation: { present: false } },
        previous: { metadata: { documentation: "pre-v2" } },
      }),
    ).toEqual({ present: false });
    expect(
      documentationUndoEntry({ version: 2, previousMetadata: { documentation: { present: true, value: "v2" } } }),
    ).toEqual({ present: true, value: "v2" });
    expect(documentationUndoEntry({ previous: { metadata: { documentation: "pre-v2", other: true } } })).toEqual({
      present: true,
      value: "pre-v2",
    });
    expect(documentationUndoEntry({ previous: { metadata: { documentation: null } } })).toEqual({
      present: true,
      value: null,
    });
    expect(documentationUndoEntry({ previous: { metadata: { other: true } } })).toEqual({ present: false });
    expect(documentationUndoEntry({ fields: ["name"], previous: { name: "Old name" } })).toBeUndefined();
    expect(documentationUndoEntry({ version: 2, previousMetadata: { schemaSql: { present: false } } })).toBeUndefined();
    expect(documentationUndoEntry({ version: 2, previousMetadata: {}, previous: { metadata: {} } })).toBeUndefined();
    expect(
      documentationUndoEntry({ [DOCUMENTATION_UNDO_KEY]: { present: true }, previousMetadata: null }),
    ).toBeUndefined();
    expect(documentationUndoEntry({})).toBeUndefined();
  });

  it("strips documentation from a copy and preserves other metadata", () => {
    const original = { documentation: "Notes", other: { retained: true } };
    const stripped = withoutDocumentation(original);
    expect(stripped as Record<string, unknown>).toEqual({ other: { retained: true } });
    expect(stripped).not.toBe(original);
    expect(original.documentation).toBe("Notes");
    expect(withoutDocumentation({ other: null })).toEqual({ other: null });
  });

  it("registers documentation at app startup and idempotently", () => {
    createApp();
    expect(isExternalMetadataKey(DOCUMENTATION_KEY)).toBe(true);
    const unregisterAgain = registerCollabDocumentation();
    unregisterAgain();
    expect(isExternalMetadataKey(DOCUMENTATION_KEY)).toBe(true);
  });
});
