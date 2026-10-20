import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stopLiveServer } from "../src/lib/live";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

// #62: access gained by opening a link-shared canvas lasts only while the canvas stays shared by link.
// A recheck interval longer than any test, so only the recheck that follows a change can close a socket here.
const api = apiClient({ liveRecheckMs: 60_000 });
const webOrigin = "http://localhost:5173";
let liveUrl = "";

beforeAll(async () => {
  await api.app.listen({ hostname: "127.0.0.1", port: 0 });
  liveUrl = (api.app.server?.url.origin ?? "").replace(/^http/, "ws");
});
afterAll(async () => {
  await stopLiveServer(api.app, 100);
});
beforeEach(() => resetLoginAttempts());

type Member = { id: string; role: string; origin: string };

async function linkSharedCanvas() {
  const owner = await api.register("Link Owner");
  const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Shared board");
  const a = await api.createNode(owner.session, canvasId, { name: "Orders API" });
  const b = await api.createNode(owner.session, canvasId, { name: "Orders DB" });
  const connectionId = await api.connect(owner.session, canvasId, a, b);
  const setShare = async (shareMode: "link" | "restricted") =>
    expect((await api.request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode })).status).toBe(200);
  await setShare("link");
  return { owner, canvasId, entityId: a, connectionId, setShare };
}

/** What a signed-in person can still see of the canvas. */
async function reach(session: string, canvasId: string, entityId: string, connectionId: string) {
  const listed = (await api.json<Array<{ id: string }>>("GET", "/api/canvases", session)).body;
  return {
    graph: (await api.request("GET", `/api/canvases/${canvasId}/graph`, session)).status,
    entity: (await api.request("GET", `/api/entities/${entityId}`, session)).status,
    connection: (await api.request("GET", `/api/connections/${connectionId}`, session)).status,
    listed: listed.some((canvas) => canvas.id === canvasId),
  };
}
const full = { graph: 200, entity: 200, connection: 200, listed: true };
const none = { graph: 403, entity: 403, connection: 403, listed: false };

function openLive(canvasId: string, session: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`${liveUrl}/api/canvases/${canvasId}/live`, {
      headers: { origin: webOrigin, cookie: session },
    } as unknown as string[]);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}
function closeCode(socket: WebSocket, timeoutMs = 2000) {
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-1), timeoutMs);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event.code);
      },
      { once: true },
    );
  });
}

describe("access gained through a canvas link", () => {
  it("ends when link sharing is turned off and returns when it is turned on again", async () => {
    const { owner, canvasId, entityId, connectionId, setShare } = await linkSharedCanvas();
    const visitor = await api.register("Link Visitor");
    const invited = await api.register("Invited Viewer");
    expect(
      (
        await api.request("POST", `/api/canvases/${canvasId}/members`, owner.session, {
          email: invited.user.email,
          role: "viewer",
        })
      ).status,
    ).toBe(201);

    // Opening the canvas through the link (the web client asks for its role first) makes the visitor a member that came
    // from the link.
    expect((await api.request("GET", `/api/canvases/${canvasId}/access`, visitor.session)).status).toBe(200);
    const members = (await api.json<Member[]>("GET", `/api/canvases/${canvasId}/members`, owner.session)).body;
    expect(members.find((member) => member.id === visitor.user.id)).toMatchObject({ role: "viewer", origin: "link" });
    expect(members.find((member) => member.id === invited.user.id)).toMatchObject({
      role: "viewer",
      origin: "invited",
    });
    expect(await reach(visitor.session, canvasId, entityId, connectionId)).toEqual(full);

    const socket = await openLive(canvasId, visitor.session);
    const closed = closeCode(socket);
    await setShare("restricted");
    expect(await closed).toBe(1008);
    expect(await reach(visitor.session, canvasId, entityId, connectionId)).toEqual(none);
    expect((await api.request("GET", `/api/canvases/${canvasId}/access`, visitor.session)).status).toBe(403);
    const restrictedMembers = (await api.json<Member[]>("GET", `/api/canvases/${canvasId}/members`, owner.session))
      .body;
    expect(restrictedMembers.some((member) => member.id === visitor.user.id)).toBe(false);
    // An invited viewer keeps access.
    expect(await reach(invited.session, canvasId, entityId, connectionId)).toEqual(full);

    // Turning the link back on works as the link does for anyone else.
    await setShare("link");
    expect(await reach(visitor.session, canvasId, entityId, connectionId)).toEqual(full);
  });

  it("is ended by an undo that restores restricted sharing", async () => {
    const { owner, canvasId, entityId, connectionId } = await linkSharedCanvas();
    const visitor = await api.register("Undo Visitor");
    expect((await api.request("GET", `/api/canvases/${canvasId}/access`, visitor.session)).status).toBe(200);
    const socket = await openLive(canvasId, visitor.session);
    const closed = closeCode(socket);
    // The last change is the share mode becoming "link"; undoing it restricts the canvas again.
    expect(
      (await api.json<{ undone: boolean }>("POST", `/api/canvases/${canvasId}/undo`, owner.session)).body,
    ).toMatchObject({ undone: true });
    expect(await closed).toBe(1008);
    expect(await reach(visitor.session, canvasId, entityId, connectionId)).toEqual(none);
  });

  it("is kept once a manager adds the person as a member", async () => {
    const { owner, canvasId, entityId, connectionId, setShare } = await linkSharedCanvas();
    const promoted = await api.register("Promoted Visitor");
    const assigned = await api.register("Assigned Visitor");
    for (const person of [promoted, assigned])
      expect((await api.request("GET", `/api/canvases/${canvasId}/access`, person.session)).status).toBe(200);
    // Adding by email, or changing the role in the member list, both invite the person.
    expect(
      (
        await api.request("POST", `/api/canvases/${canvasId}/members`, owner.session, {
          email: promoted.user.email,
          role: "viewer",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api.request("PATCH", `/api/canvases/${canvasId}/members/${assigned.user.id}`, owner.session, {
          role: "editor",
        })
      ).status,
    ).toBe(200);
    const members = (await api.json<Member[]>("GET", `/api/canvases/${canvasId}/members`, owner.session)).body;
    expect(members.filter((member) => member.origin === "link")).toEqual([]);

    await setShare("restricted");
    expect(await reach(promoted.session, canvasId, entityId, connectionId)).toEqual(full);
    expect(await reach(assigned.session, canvasId, entityId, connectionId)).toEqual(full);
    expect(
      (await api.request("PATCH", `/api/entities/${entityId}`, assigned.session, { name: "Orders API v2" })).status,
    ).toBe(200);
  });

  it("no longer counts as reading the canvas's entities when placing them on another canvas", async () => {
    const { owner, canvasId, entityId, setShare } = await linkSharedCanvas();
    const visitor = await api.register("Placing Visitor");
    // The visitor edits another canvas of the same workspace, and saw the shared one only through its link.
    const other = await api.createCanvas(owner.session, owner.workspaceId, "Other board");
    expect(
      (
        await api.request("POST", `/api/canvases/${other}/members`, owner.session, {
          email: visitor.user.email,
          role: "editor",
        })
      ).status,
    ).toBe(201);
    expect((await api.request("GET", `/api/canvases/${canvasId}/access`, visitor.session)).status).toBe(200);
    await setShare("restricted");
    const placed = await api.request("PUT", `/api/canvases/${other}/placements`, visitor.session, {
      placements: [{ entityId, parentEntityId: null, x: 0, y: 0, width: 220, height: 120 }],
    });
    expect(placed.status).toBe(400);
  });
});
