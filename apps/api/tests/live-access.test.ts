import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "@wooble/db";
import type { Actor } from "../src/lib/auth";
import { liveRoutes, stopLiveServer } from "../src/lib/live";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient, password } from "./support/client";

const webOrigin = "http://localhost:5173";
// A recheck interval longer than any test, so the periodic recheck never closes a socket here.
const api = apiClient({ liveRecheckMs: 60_000 });

// The live routes without accessGuard in front. Every upgrade succeeds, so only the check in open()
// stands between a socket and the room. A cookie's actor is whoever the test maps it to.
const actors = new Map<string, Actor>();
const unguarded = new Elysia({ serve: { reusePort: false } })
  .decorate("actor", null as Actor | null)
  .onRequest((context) => {
    context.actor = actors.get(context.request.headers.get("cookie") ?? "") ?? null;
  });
liveRoutes(unguarded, 60_000);

const origins = { guarded: "", unguarded: "" };
beforeAll(async () => {
  await api.app.listen({ hostname: "127.0.0.1", port: 0 });
  await unguarded.listen({ hostname: "127.0.0.1", port: 0 });
  origins.guarded = api.app.server?.url.origin ?? "";
  origins.unguarded = unguarded.server?.url.origin ?? "";
});
afterAll(async () => {
  await stopLiveServer(api.app, 100);
  await stopLiveServer(unguarded, 100);
});
beforeEach(() => resetLoginAttempts());

type Person = Awaited<ReturnType<typeof api.register>>;
type Message = { type: string } & Record<string, unknown>;
type Live = {
  socket: WebSocket;
  messages: Message[];
  opened: Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
  send: (message: object) => void;
};

const sockets: Live[] = [];
afterEach(() => {
  for (const live of sockets.splice(0)) live.socket.close();
});

function openLive(server: keyof typeof origins, canvasId: string, session?: string, origin = webOrigin): Live {
  const socket = new WebSocket(`${origins[server].replace(/^http/, "ws")}/api/canvases/${canvasId}/live`, {
    headers: { origin, ...(session ? { cookie: session } : {}) },
  });
  const messages: Message[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Message));
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("error", () => resolve(false), { once: true });
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
  const live = { socket, messages, opened, closed, send: (message: object) => socket.send(JSON.stringify(message)) };
  sockets.push(live);
  return live;
}

async function received(live: Live, type: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = live.messages.find((candidate) => candidate.type === type);
    if (message) return message;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
    await Bun.sleep(10);
  }
}
const closedWithin = (live: Live, ms = 1_000) => Promise.race([live.closed, Bun.sleep(ms).then(() => null)]);
const types = (live: Live) => live.messages.map((message) => message.type);

function actor(person: Person): Actor {
  return { id: person.user.id, name: person.user.name, email: person.user.email, systemRole: "user" };
}

async function joinCanvas(owner: Person, person: Person, canvasId: string, role: "editor" | "viewer") {
  const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, role);
  expect((await api.request("POST", `/api/invitations/${token}/accept`, person.session)).status).toBe(200);
}

/** A restricted Payments canvas and a link-shared status page, both owned by a workspace manager. */
async function liveFixture() {
  const owner = await api.register("Live Owner");
  const payments = await api.createCanvas(owner.session, owner.workspaceId, "Payments");
  const statusPage = await api.createCanvas(owner.session, owner.workspaceId, "Status page");
  expect((await api.request("PATCH", `/api/canvases/${statusPage}`, owner.session, { shareMode: "link" })).status).toBe(
    200,
  );
  return { owner, payments, statusPage };
}

/** The upgrade's status in process: 400 means it passed the guard and found no socket to upgrade. */
async function upgradeStatus(canvasId: string, session?: string) {
  const response = await api.app.handle(
    new Request(`http://localhost/api/canvases/${canvasId}/live`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        origin: webOrigin,
        ...(session ? { cookie: session } : {}),
      },
    }),
  );
  return response.status;
}

describe("live canvas upgrade", () => {
  it("lets in every role that can read the canvas", async () => {
    const { owner, payments, statusPage } = await liveFixture();
    const admin = await api.register("Live Admin");
    await api.promoteToAdmin(admin.user.id);
    const editor = await api.register("Live Editor");
    await joinCanvas(owner, editor, payments, "editor");
    const viewer = await api.register("Live Viewer");
    await joinCanvas(owner, viewer, payments, "viewer");
    const linkGuest = await api.register("Live Link Guest");

    for (const session of [owner.session, admin.session, editor.session, viewer.session])
      expect(await received(openLive("guarded", payments, session), "presence")).toMatchObject({ type: "presence" });
    expect(await received(openLive("guarded", statusPage, linkGuest.session), "presence")).toBeDefined();
    expect(await received(openLive("guarded", statusPage), "presence")).toBeDefined();
  });

  it("refuses an outsider and a signed-out visitor of a restricted canvas", async () => {
    const { owner, payments } = await liveFixture();
    const outsider = await api.register("Live Outsider");

    expect(await upgradeStatus(payments, owner.session)).toBe(400);
    expect(await upgradeStatus(payments, outsider.session)).toBe(403);
    expect(await upgradeStatus(payments)).toBe(401);
    const refused = openLive("guarded", payments, outsider.session);
    expect(await refused.opened).toBe(false);
    expect(refused.messages).toEqual([]);
  });

  it("closes a socket with an invalid canvas ID or origin, and refuses a missing canvas", async () => {
    const { owner, payments } = await liveFixture();
    const invalid = { code: 1008, reason: "Invalid canvas or origin" };

    // The guard leaves invalid IDs to the route, which closes the socket before any database check.
    for (const canvasId of ["not-a-uuid", "-".repeat(36)]) {
      const live = openLive("guarded", canvasId, owner.session);
      expect(await closedWithin(live)).toEqual(invalid);
      expect(live.messages).toEqual([]);
    }
    const otherSite = openLive("guarded", payments, owner.session, "https://another.example");
    expect(await closedWithin(otherSite)).toEqual(invalid);
    expect(otherSite.messages).toEqual([]);
    const missing = crypto.randomUUID();
    expect(await upgradeStatus(missing, owner.session)).toBe(403);
    expect(await upgradeStatus(missing)).toBe(401);
  });
});

describe("live canvas socket", () => {
  it("never shows presence to a socket that fails the check when it opens", async () => {
    const { owner, payments } = await liveFixture();
    const outsider = await api.register("Live Outsider");
    actors.set(owner.session, actor(owner));
    actors.set(outsider.session, actor(outsider));
    const ownerLive = openLive("unguarded", payments, owner.session);
    await received(ownerLive, "presence");

    const outsiderLive = openLive("unguarded", payments, outsider.session);
    expect(await outsiderLive.opened).toBe(true);
    outsiderLive.send({ type: "cursor", x: 10, y: 20 });
    const anonymousLive = openLive("unguarded", payments);
    expect(await anonymousLive.opened).toBe(true);

    expect(await closedWithin(outsiderLive)).toEqual({ code: 1008, reason: "Canvas access denied" });
    expect(await closedWithin(anonymousLive)).toEqual({ code: 1008, reason: "Canvas access denied" });
    await Bun.sleep(50);
    expect(outsiderLive.messages).toEqual([]);
    expect(anonymousLive.messages).toEqual([]);
    expect(types(ownerLive)).toEqual(["presence"]);
  });

  it("refuses a session that ended before the socket opened", async () => {
    const { owner, payments } = await liveFixture();
    const viewer = await api.register("Live Viewer");
    await joinCanvas(owner, viewer, payments, "viewer");
    actors.set(viewer.session, actor(viewer));
    expect((await api.request("POST", "/api/auth/logout", viewer.session)).status).toBe(200);

    const viewerLive = openLive("unguarded", payments, viewer.session);
    expect(await closedWithin(viewerLive)).toEqual({ code: 1008, reason: "Canvas access denied" });
    expect(viewerLive.messages).toEqual([]);
  });

  it("holds messages until the check passes, then relays them in order", async () => {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Live Editor");
    await joinCanvas(owner, editor, payments, "editor");
    actors.set(owner.session, actor(owner));
    actors.set(editor.session, actor(editor));
    const ownerLive = openLive("unguarded", payments, owner.session);
    await received(ownerLive, "presence");

    let editorLive: Live | undefined;
    await db.transaction(async (tx) => {
      // The check reads the editor's session, so it waits for this lock and the socket stays outside.
      await tx.execute(sql`lock table sessions in access exclusive mode`);
      editorLive = openLive("unguarded", payments, editor.session);
      expect(await editorLive.opened).toBe(true);
      editorLive.send({ type: "selection", kind: "node", id: crypto.randomUUID() });
      editorLive.send({ type: "cursor", x: 12, y: 34 });
      await Bun.sleep(100);
      expect(editorLive.messages).toEqual([]);
      expect(types(ownerLive)).toEqual(["presence"]);
    });
    if (!editorLive) throw new Error("Editor socket did not open");

    expect(await received(editorLive, "presence")).toMatchObject({ peers: [{ name: "Live Owner" }] });
    expect(await received(ownerLive, "cursor")).toMatchObject({ name: "Live Editor", x: 12, y: 34 });
    expect(types(ownerLive)).toEqual(["presence", "joined", "selection", "cursor"]);
  });

  it("drops a socket that closes while its check is still running", async () => {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Live Editor");
    await joinCanvas(owner, editor, payments, "editor");
    actors.set(owner.session, actor(owner));
    actors.set(editor.session, actor(editor));
    const ownerLive = openLive("unguarded", payments, owner.session);
    await received(ownerLive, "presence");

    await db.transaction(async (tx) => {
      await tx.execute(sql`lock table sessions in access exclusive mode`);
      const editorLive = openLive("unguarded", payments, editor.session);
      expect(await editorLive.opened).toBe(true);
      editorLive.socket.close();
      await editorLive.closed;
    });
    await Bun.sleep(100);

    expect(types(ownerLive)).toEqual(["presence"]);
  });
});

describe("live canvas revocation", () => {
  const changed = { code: 1008, reason: "Canvas access changed" };

  async function signIn(person: Person) {
    const response = await api.request("POST", "/api/auth/login", undefined, { email: person.user.email, password });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")?.split(";")[0] as string;
  }
  async function present(...sessions: Array<[canvasId: string, session: string]>) {
    const opened = sessions.map(([canvasId, session]) => openLive("guarded", canvasId, session));
    for (const live of opened) await received(live, "presence");
    return opened;
  }

  it("closes the socket of a session that signs out, and every one after a password change", async () => {
    const { owner, payments } = await liveFixture();
    const viewer = await api.register("Live Viewer");
    await joinCanvas(owner, viewer, payments, "viewer");
    const otherSession = await signIn(viewer);
    const [first, second, ownerLive] = await present(
      [payments, viewer.session],
      [payments, otherSession],
      [payments, owner.session],
    );

    expect((await api.request("POST", "/api/auth/logout", viewer.session)).status).toBe(200);
    expect(await closedWithin(first)).toEqual(changed);
    expect(await closedWithin(second, 200)).toBeNull();

    const passwordChange = { currentPassword: password, newPassword: "WoobleChangedPassword-2026" };
    expect((await api.request("PUT", "/api/auth/password", otherSession, passwordChange)).status).toBe(200);
    expect(await closedWithin(second)).toEqual(changed);
    expect(await closedWithin(ownerLive, 200)).toBeNull();
  });

  it("closes an admin's socket when the admin role is removed", async () => {
    const { owner, payments } = await liveFixture();
    await api.promoteToAdmin(owner.user.id);
    const admin = await api.register("Live Admin");
    await api.promoteToAdmin(admin.user.id);
    const [adminLive, ownerLive] = await present([payments, admin.session], [payments, owner.session]);

    const demotion = await api.request("PATCH", `/api/admin/users/${admin.user.id}`, owner.session, {
      systemRole: "user",
    });
    expect(demotion.status).toBe(200);
    expect(await closedWithin(adminLive)).toEqual(changed);
    expect(await closedWithin(ownerLive, 200)).toBeNull();
  });

  it("closes sockets when a workspace member change ends access", async () => {
    const { owner, payments } = await liveFixture();
    const members = `/api/workspaces/${owner.workspaceId}/members`;
    const manager = await api.register("Live Manager");
    const asManager = { email: manager.user.email, role: "manager" };
    expect((await api.request("POST", members, owner.session, asManager)).status).toBe(201);
    const viewer = await api.register("Live Viewer");
    await joinCanvas(owner, viewer, payments, "viewer");
    const [managerLive, viewerLive, ownerLive] = await present(
      [payments, manager.session],
      [payments, viewer.session],
      [payments, owner.session],
    );

    // A demoted manager keeps no role on the canvas.
    expect(
      (await api.request("PATCH", `${members}/${manager.user.id}`, owner.session, { role: "member" })).status,
    ).toBe(200);
    expect(await closedWithin(managerLive)).toEqual(changed);
    expect(await closedWithin(viewerLive, 200)).toBeNull();

    // Adding someone again with a lower role demotes them too.
    expect((await api.request("POST", members, owner.session, asManager)).status).toBe(201);
    const [promotedLive] = await present([payments, manager.session]);
    expect((await api.request("POST", members, owner.session, { ...asManager, role: "member" })).status).toBe(201);
    expect(await closedWithin(promotedLive)).toEqual(changed);

    // Removing a member also removes their canvas roles.
    expect((await api.request("DELETE", `${members}/${viewer.user.id}`, owner.session)).status).toBe(200);
    expect(await closedWithin(viewerLive)).toEqual(changed);
    expect(await closedWithin(ownerLive, 200)).toBeNull();
  });

  it("closes a socket when its canvas role is removed", async () => {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Live Editor");
    await joinCanvas(owner, editor, payments, "editor");
    const [editorLive, ownerLive] = await present([payments, editor.session], [payments, owner.session]);

    expect(
      (await api.request("DELETE", `/api/canvases/${payments}/members/${editor.user.id}`, owner.session)).status,
    ).toBe(200);
    expect(await closedWithin(editorLive)).toEqual(changed);
    expect(await closedWithin(ownerLive, 200)).toBeNull();
  });

  it("keeps sockets open after a change that leaves access in place", async () => {
    const { owner, payments } = await liveFixture();
    const viewer = await api.register("Live Viewer");
    await joinCanvas(owner, viewer, payments, "viewer");
    const [viewerLive] = await present([payments, viewer.session]);

    expect((await api.request("PATCH", "/api/auth/profile", viewer.session, { name: "Live Reader" })).status).toBe(200);
    // Refused requests change nothing, so they recheck nothing.
    const wrongPassword = { currentPassword: "NotTheRightPassword-2026", newPassword: "WoobleChangedPassword-2026" };
    expect((await api.request("PUT", "/api/auth/password", viewer.session, wrongPassword)).status).toBe(403);
    expect((await api.request("PATCH", `/api/admin/users/${viewer.user.id}`, owner.session, {})).status).toBe(403);
    expect(await closedWithin(viewerLive, 300)).toBeNull();
  });
});
