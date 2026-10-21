import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { collabDocuments, workspaces } from "@wooble/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must point at an isolated test database");
const database = drizzle(databaseUrl);
const workspaceId = randomUUID();

async function insertDocument(overrides: Partial<typeof collabDocuments.$inferInsert> = {}) {
  return database
    .insert(collabDocuments)
    .values({
      workspaceId,
      objectKind: "entity",
      objectId: randomUUID(),
      field: "documentation",
      ...overrides,
    })
    .returning();
}

describe("collab_documents schema", () => {
  beforeAll(async () => {
    await database.insert(workspaces).values({ id: workspaceId, name: "Collab schema test" });
  });

  afterAll(async () => {
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await database.$client.end();
  });

  it("round trips bytea exactly, including empty buffers", async () => {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x00]);
    const [row] = await insertDocument({
      state: payload,
      bootstrapVersion: 1,
      mirrorMarkdown: "",
      mirrorSha256: "0".repeat(64),
    });
    expect(row?.state).toBeInstanceOf(Buffer);
    expect(row?.state).toEqual(payload);

    const [empty] = await insertDocument({
      state: Buffer.alloc(0),
      bootstrapVersion: 1,
      mirrorMarkdown: "",
      mirrorSha256: "0".repeat(64),
    });
    expect(empty?.state).toBeInstanceOf(Buffer);
    expect(empty?.state).toEqual(Buffer.alloc(0));
  });

  it("enforces identity uniqueness and all persistence checks", async () => {
    const objectId = randomUUID();
    await insertDocument({ objectId });
    await expect(insertDocument({ objectId })).rejects.toThrow();

    const rejects = (overrides: Partial<typeof collabDocuments.$inferInsert>) =>
      expect(insertDocument(overrides)).rejects.toThrow();
    await rejects({ objectKind: "canvas" as never });
    await rejects({ field: "name" as never });
    await rejects({
      state: Buffer.alloc(2 * 1024 * 1024 + 1),
      bootstrapVersion: 1,
      mirrorMarkdown: "",
      mirrorSha256: "0".repeat(64),
    });
    await rejects({ mirrorMarkdown: "x".repeat(20001), mirrorSha256: "0".repeat(64) });
    await rejects({ mirrorMarkdown: "x", mirrorSha256: "A".repeat(64) });
    await rejects({ mirrorMarkdown: "x" });
    await rejects({ state: Buffer.from([1]) });
    await rejects({ revision: -1 });
  });

  it("accepts placeholders and cascades when the workspace is deleted", async () => {
    const [placeholder] = await insertDocument();
    expect(placeholder?.state).toBeNull();
    expect(placeholder?.mirrorMarkdown).toBeNull();
    expect(placeholder?.originalMarkdown).toBeNull();

    const cascadeWorkspace = randomUUID();
    await database.insert(workspaces).values({ id: cascadeWorkspace, name: "Cascade test" });
    const [row] = await database
      .insert(collabDocuments)
      .values({
        workspaceId: cascadeWorkspace,
        objectKind: "connection",
        objectId: randomUUID(),
        field: "documentation",
      })
      .returning();
    expect(row).toBeDefined();
    await database.delete(workspaces).where(eq(workspaces.id, cascadeWorkspace));
    const remaining = await database
      .select({ id: collabDocuments.id })
      .from(collabDocuments)
      .where(eq(collabDocuments.id, row?.id ?? ""));
    expect(remaining).toHaveLength(0);
  });
});
