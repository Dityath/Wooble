import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { canvases, collabDocuments, connections, db, entities } from "@wooble/db";
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
  documentationUndoEntry,
  isBootstrapped,
  registerCollabDocumentation,
  reprojectMirror,
  restoreDocumentation,
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
    await tx.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, f.canvasId)).for("update");
    for (const ref of [...f.refs].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
      const table = tableFor(ref);
      await tx.select({ id: table.id }).from(table).where(eq(table.id, ref.id)).for("update");
    }
    return callback(tx);
  });
}

async function metadata(tx: Transaction, ref: DocumentRef): Promise<Record<string, unknown>> {
  const table = tableFor(ref);
  const [row] = await tx.select({ metadata: table.metadata }).from(table).where(eq(table.id, ref.id));
  return row.metadata;
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

    it(`fails closed for a ${kind} workspace mismatch and rolls back caller writes`, async () => {
      const f = await fixture();
      const ref = f[kind];
      await bootstrap(ref, "Private mirror", { workspaceId: otherOwner.workspaceId });
      const actions = [
        (tx: Transaction) => writeDocumentation(tx, ref, "Private replacement"),
        (tx: Transaction) => restoreDocumentation(tx, ref, undefined),
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

  it("throws for a missing write owner and skips missing restore/read owners", async () => {
    const f = await fixture();
    for (const kind of ["entity", "connection"] as const) {
      const ref: DocumentRef = { kind, id: crypto.randomUUID() };
      await expect(locked(f, (tx) => writeDocumentation(tx, ref, "Missing"))).rejects.toThrow(
        "Documentation owner not found",
      );
      await locked(f, async (tx) => {
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
