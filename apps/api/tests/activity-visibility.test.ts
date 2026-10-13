import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { canvasEvents, db } from "@wooble/db";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

/** Fictional private text that must never reach a reader of the activity feed. */
const sentinels = {
  documentation: "DOC-SENTINEL-4f21c7",
  contractBody: "CONTRACT-SENTINEL-b83d10",
  schemaSql: "SCHEMA-SENTINEL-7a5e62",
};
const allSentinels = Object.values(sentinels);

/** Every field the activity log renders, plus the undo bookkeeping it needs. */
const displayedFields = [
  "id",
  "actorUserId",
  "actorName",
  "action",
  "targetType",
  "targetId",
  "targetName",
  "undoneAt",
  "createdAt",
];

type Feed = { events: Array<Record<string, unknown>> };

/** The raw response text, so a nested leak cannot hide behind a type-level assertion. */
async function readFeed(session: string | undefined, canvasId: string) {
  const response = await api.request("GET", `/api/canvases/${canvasId}/activity`, session);
  const text = await response.text();
  return { status: response.status, text, body: text ? (JSON.parse(text) as Feed) : null };
}

/** Every path in the parsed body whose key is one of `keys`, however deeply nested. */
function pathsWithKeys(value: unknown, keys: string[], trail = "body"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => pathsWithKeys(item, keys, `${trail}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(keys.includes(key) ? [`${trail}.${key}`] : []),
    ...pathsWithKeys(child, keys, `${trail}.${key}`),
  ]);
}

/**
 * A value is written and then changed again: only the second event stores the first value as its
 * undo payload, so the feed would carry it if the payload were not withheld. The deleted node
 * records a full subgraph snapshot for the same reason.
 */
async function seedPrivateHistory(session: string, canvasId: string) {
  const service = await api.createNode(session, canvasId, { name: "Orders API" });
  const database = await api.createNode(session, canvasId, { type: "database", name: "Orders DB", x: 500 });
  const retired = await api.createNode(session, canvasId, { name: "Retired Worker", y: 400 });
  const connectionId = await api.connect(session, canvasId, service, database);

  await api.request("PATCH", `/api/entities/${service}`, session, {
    metadata: { documentation: sentinels.documentation },
  });
  await api.request("PATCH", `/api/entities/${service}`, session, { name: "Orders API v2" });
  await api.request("PATCH", `/api/connections/${connectionId}`, session, {
    metadata: { contractBody: sentinels.contractBody },
  });
  await api.request("PATCH", `/api/connections/${connectionId}`, session, { label: "Loads orders" });
  await api.request("PATCH", `/api/entities/${database}`, session, { metadata: { schemaSql: sentinels.schemaSql } });
  await api.request("PATCH", `/api/entities/${database}`, session, { description: "Primary store" });
  expect((await api.request("DELETE", `/api/canvases/${canvasId}/entities/${retired}`, session)).status).toBe(200);

  return { service, database, connectionId, retired };
}

/** The undo payloads the API stores server-side, read straight from the table. */
async function storedMetadata(canvasId: string) {
  const rows = await db
    .select({ metadata: canvasEvents.metadata })
    .from(canvasEvents)
    .where(eq(canvasEvents.canvasId, canvasId));
  return JSON.stringify(rows);
}

async function expectNoPrivatePayloads(read: Awaited<ReturnType<typeof readFeed>>) {
  expect(read.status).toBe(200);
  for (const sentinel of allSentinels) expect(read.text).not.toContain(sentinel);
  expect(pathsWithKeys(read.body, ["previous", "snapshot", "previousMetadata"])).toEqual([]);
  for (const event of read.body?.events ?? []) {
    for (const field of displayedFields) expect(Object.hasOwn(event, field)).toBe(true);
  }
}

async function joinCanvas(ownerSession: string, canvasId: string, role: "editor" | "viewer" = "viewer") {
  const guest = await api.register(`Activity ${role}`);
  const token = await api.invite(ownerSession, `/api/canvases/${canvasId}/invitations`, role);
  await api.json("POST", `/api/invitations/${token}/accept`, guest.session);
  return guest;
}

describe("activity feed withholds undo payloads", () => {
  it("gives a canvas viewer the history without previous values or snapshots", async () => {
    const owner = await api.register("Activity Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Orders");
    await seedPrivateHistory(owner.session, canvasId);
    // The stored rows still hold every private value: this is redaction, not deletion.
    const stored = await storedMetadata(canvasId);
    for (const sentinel of allSentinels) expect(stored).toContain(sentinel);

    const viewer = await joinCanvas(owner.session, canvasId);
    await expectNoPrivatePayloads(await readFeed(viewer.session, canvasId));
  });

  it("gives a signed-in link guest the history without previous values or snapshots", async () => {
    const owner = await api.register("Link Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Published orders");
    await seedPrivateHistory(owner.session, canvasId);
    expect((await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "link" })).status).toBe(
      200,
    );

    const linkGuest = await api.register("Link Guest");
    await expectNoPrivatePayloads(await readFeed(linkGuest.session, canvasId));

    // A signed-out visitor of the same link is refused, as before: the guard never listed the
    // activity route as a public read. No payload is exposed either way.
    const anonymous = await readFeed(undefined, canvasId);
    expect(anonymous.status).toBe(401);
    for (const sentinel of allSentinels) expect(anonymous.text).not.toContain(sentinel);
  });

  it("shows the owner the same events as a viewer, with the same undo bookkeeping", async () => {
    const owner = await api.register("Trail Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Orders");
    await seedPrivateHistory(owner.session, canvasId);
    const viewer = await joinCanvas(owner.session, canvasId);

    const asOwner = await readFeed(owner.session, canvasId);
    const asViewer = await readFeed(viewer.session, canvasId);
    const trail = (read: Awaited<ReturnType<typeof readFeed>>) =>
      (read.body?.events ?? []).map((event) => ({
        id: event.id,
        action: event.action,
        targetName: event.targetName,
        targetId: event.targetId,
        undoneAt: event.undoneAt,
        createdAt: event.createdAt,
      }));

    expect(asOwner.status).toBe(200);
    const ownerTrail = trail(asOwner);
    expect(ownerTrail.length).toBeGreaterThan(0);
    expect(trail(asViewer)).toEqual(ownerTrail);
    expect(new Set(ownerTrail.map((event) => event.action))).toContain("entity.deleted");
  });

  it("still undoes a documentation change after the redacted read", async () => {
    const owner = await api.register("Redacted Undo Owner");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Orders");
    const ledger = await api.createNode(owner.session, canvasId, { name: "Ledger API" });
    await api.request("PATCH", `/api/entities/${ledger}`, owner.session, {
      metadata: { documentation: sentinels.documentation },
    });
    await api.request("PATCH", `/api/entities/${ledger}`, owner.session, {
      metadata: { documentation: "second draft" },
    });
    const viewer = await joinCanvas(owner.session, canvasId);
    await expectNoPrivatePayloads(await readFeed(viewer.session, canvasId));

    const undo = await api.json<{ undone: boolean; action?: string }>(
      "POST",
      `/api/canvases/${canvasId}/undo`,
      owner.session,
    );
    expect(undo.body).toMatchObject({ undone: true, action: "entity.updated" });
    const graph = await api.json<{ entities: Array<{ id: string; metadata: Record<string, unknown> }> }>(
      "GET",
      `/api/canvases/${canvasId}/graph`,
      owner.session,
    );
    expect(graph.body.entities.find((entity) => entity.id === ledger)?.metadata.documentation).toBe(
      sentinels.documentation,
    );
  });
});
