import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { canvases, db, sessions } from "@wooble/db";
import type { Actor } from "../src/lib/auth";
import { liveRoutes, stopLiveServer } from "../src/lib/live";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient, password } from "./support/client";
import { openRawWebSocket, type RawWebSocket } from "./support/raw-websocket";

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

// The same, with a short recheck interval, for the periodic recheck.
const periodic = new Elysia({ serve: { reusePort: false } })
  .decorate("actor", null as Actor | null)
  .onRequest((context) => {
    context.actor = actors.get(context.request.headers.get("cookie") ?? "") ?? null;
  });
liveRoutes(periodic, 100);

// Unguarded apps for sockets that never answer a close frame. The terminate delay is short but long
// enough to make assertions inside the close window. The stub PATCH route runs the same
// after-response recheck and `graph:changed` broadcast as the real canvas route, without the guard.
const terminateAfterMs = 1000;
function rawApp(recheckMs: number, terminateMs = terminateAfterMs) {
  const app = new Elysia({ serve: { reusePort: false } })
    .decorate("actor", null as Actor | null)
    .onRequest((context) => {
      context.actor = actors.get(context.request.headers.get("cookie") ?? "") ?? null;
    });
  liveRoutes(app, recheckMs, { terminateAfterMs: terminateMs });
  app.patch("/api/canvases/:canvasId", () => ({ ok: true }));
  return app;
}
const rawLive = rawApp(60_000);
const rawPeriodic = rawApp(100);
// A delay no other app uses, so the timer-leak test can tell live.ts's terminate timers from all others.
const leakTerminateAfterMs = 1337;
const rawLeak = rawApp(60_000, leakTerminateAfterMs);

const origins = { guarded: "", unguarded: "", periodic: "", rawLive: "", rawPeriodic: "", rawLeak: "" };
beforeAll(async () => {
  await api.app.listen({ hostname: "127.0.0.1", port: 0 });
  await unguarded.listen({ hostname: "127.0.0.1", port: 0 });
  await periodic.listen({ hostname: "127.0.0.1", port: 0 });
  await rawLive.listen({ hostname: "127.0.0.1", port: 0 });
  await rawPeriodic.listen({ hostname: "127.0.0.1", port: 0 });
  await rawLeak.listen({ hostname: "127.0.0.1", port: 0 });
  origins.rawLeak = rawLeak.server?.url.origin ?? "";
  origins.rawLive = rawLive.server?.url.origin ?? "";
  origins.rawPeriodic = rawPeriodic.server?.url.origin ?? "";
  origins.periodic = periodic.server?.url.origin ?? "";
  origins.guarded = api.app.server?.url.origin ?? "";
  origins.unguarded = unguarded.server?.url.origin ?? "";
});
afterAll(async () => {
  await stopLiveServer(api.app, 100);
  await stopLiveServer(unguarded, 100);
  await stopLiveServer(periodic, 100);
  await stopLiveServer(rawLive, 100);
  await stopLiveServer(rawPeriodic, 100);
  await stopLiveServer(rawLeak, 100);
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
const rawSockets: RawWebSocket[] = [];
afterEach(() => {
  for (const live of sockets.splice(0)) live.socket.close();
  for (const raw of rawSockets.splice(0)) raw.destroy();
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

  it("closes with 1011, before any presence, when the access check cannot run", async () => {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Live Unchecked");
    await joinCanvas(owner, editor, payments, "editor");
    actors.set(owner.session, actor(owner));
    actors.set(editor.session, actor(editor));
    const ownerLive = openLive("unguarded", payments, owner.session);
    await received(ownerLive, "presence");

    // The next query is the open-time session check of the editor's socket.
    const select = spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    try {
      const editorLive = openLive("unguarded", payments, editor.session);
      expect(await closedWithin(editorLive)).toEqual({ code: 1011, reason: "Access check unavailable" });
      expect(editorLive.messages).toEqual([]);
    } finally {
      select.mockRestore();
    }
    await Bun.sleep(50);
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

describe("live canvas recheck failures", () => {
  const unavailable = { code: 1011, reason: "Access check unavailable" };

  /** The owner's socket, then the editor's, both joined to the same canvas. */
  async function signedInPair() {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Live Editor");
    await joinCanvas(owner, editor, payments, "editor");
    const ownerLive = openLive("guarded", payments, owner.session);
    await received(ownerLive, "presence");
    const editorLive = openLive("guarded", payments, editor.session);
    await received(editorLive, "presence");
    return { owner, payments, ownerLive, editorLive };
  }

  /**
   * Throws the next time live.ts starts a signed-in peer's access check, and only that once.
   * It is deterministic because canReadCanvas probes the session with a selection of the bare
   * sessions.userId column, which no other query issues (the access guard reads that column with
   * expiresAt, and the queries around it select canvases, users or canvas members instead), so the
   * canvas PATCH below gets through untouched. revalidatePeers then walks `connected` in insertion
   * order and calls canReadCanvas for the owner before the editor, and every query after the throw
   * runs normally, so exactly the owner's recheck fails.
   *
   * The caller keeps the spy in place until it has seen the failure: onAfterResponse rechecks the
   * peers after the response resolves, and the throw has to survive until then. The mock disarms
   * itself on the throw, so it answers every later query as the database does.
   */
  function failNextAccessProbe() {
    const original = db.select.bind(db);
    let armed = true;
    const failing = ((fields?: unknown) => {
      const probe = fields as { userId?: unknown } | undefined;
      if (armed && probe && Object.keys(probe).length === 1 && probe.userId === sessions.userId) {
        armed = false;
        throw new Error("database unavailable");
      }
      return original(fields as never);
    }) as unknown as typeof db.select;
    return spyOn(db, "select").mockImplementation(failing);
  }

  it("closes the peer whose recheck failed and keeps revalidating the others", async () => {
    const { owner, payments, ownerLive, editorLive } = await signedInPair();

    // The rename leaves both peers' access in place, so every peer on the canvas is rechecked.
    const select = failNextAccessProbe();
    try {
      const rename = await api.request("PATCH", `/api/canvases/${payments}`, owner.session, { name: "Payments now" });
      expect(rename.status).toBe(200);

      expect(await closedWithin(ownerLive)).toEqual(unavailable);
      expect(await closedWithin(editorLive, 300)).toBeNull();
      // The editor was rechecked after the failure and still sees the change that triggered it.
      expect(await received(editorLive, "left")).toMatchObject({ type: "left" });
      expect(await received(editorLive, "graph:changed")).toMatchObject({ type: "graph:changed" });

      // The editor still relays: a socket that joins afterwards receives its cursor.
      const laterLive = openLive("guarded", payments, owner.session);
      expect(await received(laterLive, "presence")).toMatchObject({ peers: [{ name: "Live Editor" }] });
      editorLive.send({ type: "cursor", x: 5, y: 6 });
      expect(await received(laterLive, "cursor")).toMatchObject({ name: "Live Editor", x: 5, y: 6 });
    } finally {
      select.mockRestore();
    }
  });

  it("sends nothing to a peer whose recheck failed, and relays nothing from it", async () => {
    const { owner, payments, ownerLive, editorLive } = await signedInPair();
    // The owner is in the room, and the editor receives its frames, before the failure.
    ownerLive.send({ type: "activity" });
    expect(await received(editorLive, "activity")).toMatchObject({ type: "activity" });

    const select = failNextAccessProbe();
    try {
      const rename = await api.request("PATCH", `/api/canvases/${payments}`, owner.session, { name: "Payments now" });
      expect(rename.status).toBe(200);

      expect(await closedWithin(ownerLive)).toEqual(unavailable);
      const left = await received(editorLive, "left");
      const ownerPeerId = left.id;
      const afterClose = [...ownerLive.messages];

      // A later socket sees a presence snapshot without the peer that failed its check.
      const laterLive = openLive("guarded", payments, owner.session);
      expect(await received(laterLive, "presence")).toMatchObject({ peers: [{ name: "Live Editor" }] });
      editorLive.send({ type: "cursor", x: 30, y: 40 });
      editorLive.send({ type: "selection", kind: "node", id: crypto.randomUUID() });
      editorLive.send({ type: "activity" });
      expect(await received(laterLive, "cursor")).toMatchObject({ x: 30, y: 40 });
      expect(await received(laterLive, "selection")).toMatchObject({ selection: { kind: "node" } });
      expect(await received(laterLive, "activity")).toMatchObject({ type: "activity" });

      // A canvas change broadcasts to the room, and rechecks only the peers that are still in it.
      const again = await api.request("PATCH", `/api/canvases/${payments}`, owner.session, { name: "Later" });
      expect(again.status).toBe(200);
      expect(await received(laterLive, "graph:changed")).toMatchObject({ type: "graph:changed" });
      await Bun.sleep(100);

      expect(ownerLive.messages).toEqual(afterClose);
      expect(types(ownerLive)).not.toContain("graph:changed");
      // Only the activity from before the failure reached the editor, and `left` says it once.
      expect(editorLive.messages.filter((message) => message.id === ownerPeerId && message.type !== "left")).toEqual([
        expect.objectContaining({ type: "activity" }),
      ]);
      expect(editorLive.messages.filter((message) => message.type === "left")).toHaveLength(1);
    } finally {
      select.mockRestore();
    }
  });
});

describe("live canvas periodic recheck failures", () => {
  it("closes the peer whose periodic recheck failed, detaches it, and leaves the other peer alone", async () => {
    const { owner, payments } = await liveFixture();
    const editor = await api.register("Periodic Editor");
    await joinCanvas(owner, editor, payments, "editor");
    actors.set(owner.session, actor(owner));
    actors.set(editor.session, actor(editor));
    const ownerLive = openLive("periodic", payments, owner.session);
    await received(ownerLive, "presence");
    const editorLive = openLive("periodic", payments, editor.session);
    await received(editorLive, "presence");
    await received(ownerLive, "joined");

    // The session probe is the first query of every signed-in recheck. Fail exactly one of them; the
    // peer whose timer fires first is the one that fails, and the outcome says which.
    const original = db.select.bind(db);
    let armed = true;
    let probes = 0;
    const select = spyOn(db, "select").mockImplementation(((fields?: unknown) => {
      const probe = fields as { userId?: unknown } | undefined;
      if (probe && Object.keys(probe).length === 1 && probe.userId === sessions.userId) {
        probes++;
        if (armed) {
          armed = false;
          throw new Error("database unavailable");
        }
      }
      return original(fields as never);
    }) as unknown as typeof db.select);
    try {
      const first = await Promise.race([
        ownerLive.closed.then(() => "owner" as const),
        editorLive.closed.then(() => "editor" as const),
        Bun.sleep(3_000).then(() => null),
      ]);
      expect(first).not.toBeNull();
      const [failed, survivor] = first === "owner" ? [ownerLive, editorLive] : [editorLive, ownerLive];
      expect(await failed.closed).toEqual({ code: 1011, reason: "Access check unavailable" });

      const failedPeerId = (await received(survivor, "left")).id;
      const afterClose = [...failed.messages];
      // Later periodic rechecks of the survivor run and pass: wait for two more probes.
      const seen = probes;
      const deadline = Date.now() + 3_000;
      while (probes < seen + 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(probes).toBeGreaterThanOrEqual(seen + 2);
      expect(survivor.socket.readyState).toBe(WebSocket.OPEN);

      survivor.send({ type: "cursor", x: 1, y: 2 });
      survivor.send({ type: "activity" });
      await Bun.sleep(100);
      expect(failed.messages).toEqual(afterClose);
      expect(survivor.messages.filter((message) => message.type === "left")).toHaveLength(1);
      expect(survivor.messages.filter((message) => message.id === failedPeerId && message.type !== "left")).toEqual([]);
    } finally {
      select.mockRestore();
    }
  });
});

// Evidence boundary: on Bun 1.3.14 the server's close handler runs synchronously inside ws.close(), so
// these tests cannot tell "detach before close" from "detach in the close handler", and the terminate
// fallback (a timer that ends a client that never answers) is unobservable here and stays unverified.
// What they do cover is frame isolation: a client that never answers the close frame receives nothing
// further, and nothing it sends is relayed, while its TCP connection is still open.
describe("live frame isolation for a client that never answers the close frame", () => {
  const changed = { code: 1008, reason: "Canvas access changed" };
  const unavailable = { code: 1011, reason: "Access check unavailable" };
  type Server = "rawLive" | "rawPeriodic" | "rawLeak";

  /** A signed-in raw peer that never answers a close frame, and a guest in the same room. */
  async function rawPair(server: Server) {
    const { owner, statusPage } = await liveFixture();
    const person = await api.register("Raw Editor");
    actors.set(person.session, actor(person));
    const guest = openLive(server, statusPage);
    await received(guest, "presence");
    const raw = await openRawWebSocket(`${origins[server].replace(/^http/, "ws")}/api/canvases/${statusPage}/live`, {
      origin: webOrigin,
      cookie: person.session,
    });
    rawSockets.push(raw);
    await waitFor(() => raw.messages.some((message) => message.type === "presence"));
    const joined = await received(guest, "joined");
    return { owner, person, statusPage, guest, raw, rawId: joined.id as string, server };
  }
  async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out");
      await Bun.sleep(10);
    }
  }
  /** Fails the next signed-in session probe once; only the raw peer is signed in, the guest never probes. */
  function failNextProbe() {
    const original = db.select.bind(db);
    let armed = true;
    return spyOn(db, "select").mockImplementation(((fields?: unknown) => {
      const probe = fields as { userId?: unknown } | undefined;
      if (armed && probe && Object.keys(probe).length === 1 && probe.userId === sessions.userId) {
        armed = false;
        throw new Error("database unavailable");
      }
      return original(fields as never);
    }) as unknown as typeof db.select);
  }
  const patch = (server: Server, canvasId: string) =>
    fetch(`${origins[server]}/api/canvases/${canvasId}`, { method: "PATCH" });

  /** Everything that must hold while the raw client sits in the server's close window. */
  async function expectDetachedInCloseWindow(
    { guest, raw, rawId, statusPage, server }: Awaited<ReturnType<typeof rawPair>>,
    closeFrame: { code: number; reason: string },
  ) {
    // The guest hears `left` at once, with the raw client's TCP connection still open and unanswered.
    await received(guest, "left", terminateAfterMs / 2);
    await waitFor(() => raw.closeFrame !== null);
    expect(raw.closeFrame).toEqual(closeFrame);
    // The checks below are only meaningful while the raw client is still connected.
    expect(raw.isTcpClosed()).toBe(false);
    const before = raw.messages.length;

    // Frames from the room no longer reach the raw client...
    guest.send({ type: "cursor", x: 7, y: 8 });
    guest.send({ type: "selection", kind: "node", id: crypto.randomUUID() });
    guest.send({ type: "activity" });
    expect((await patch(server, statusPage)).status).toBe(200);
    // ...its own frames are not relayed...
    raw.send({ type: "cursor", x: 1, y: 2 });
    raw.send({ type: "selection", kind: "node", id: crypto.randomUUID() });
    raw.send({ type: "activity" });
    // ...and a socket that joins now does not see it.
    const later = openLive(server, statusPage);
    const presence = await received(later, "presence");
    await Bun.sleep(150);
    expect(raw.isTcpClosed()).toBe(false);
    expect(raw.afterClose).toEqual([]);
    expect(raw.messages).toHaveLength(before);
    expect((presence.peers as Array<{ id: string }>).map((peer) => peer.id)).not.toContain(rawId);
    expect(
      guest.messages.filter((message) => message.id === rawId && !["joined", "left"].includes(message.type)),
    ).toEqual([]);
    // The later socket may see the canvas change, but nothing from the raw peer.
    expect(types(later).filter((type) => type !== "graph:changed")).toEqual(["presence"]);
    expect(guest.messages.filter((message) => message.type === "left")).toHaveLength(1);
  }

  it("detaches a peer whose immediate recheck failed without relaying frames while it never answers the close frame", async () => {
    const pair = await rawPair("rawLive");
    const select = failNextProbe();
    try {
      expect((await patch("rawLive", pair.statusPage)).status).toBe(200);
      await expectDetachedInCloseWindow(pair, unavailable);
    } finally {
      select.mockRestore();
    }
  });

  it("detaches a peer whose periodic recheck failed without relaying frames while it never answers the close frame", async () => {
    const pair = await rawPair("rawPeriodic");
    const select = failNextProbe();
    try {
      await waitFor(() => pair.raw.closeFrame !== null);
      await expectDetachedInCloseWindow(pair, unavailable);
    } finally {
      select.mockRestore();
    }
  });

  it("detaches a peer revoked by a periodic recheck without relaying frames while it never answers the close frame", async () => {
    const pair = await rawPair("rawPeriodic");
    expect((await api.request("POST", "/api/auth/logout", pair.person.session)).status).toBe(200);
    await expectDetachedInCloseWindow(pair, changed);
  });

  it("detaches a revoked peer without relaying frames while it never answers the close frame", async () => {
    const pair = await rawPair("rawLive");
    expect((await api.request("POST", "/api/auth/logout", pair.person.session)).status).toBe(200);
    expect((await patch("rawLive", pair.statusPage)).status).toBe(200);
    await expectDetachedInCloseWindow(pair, changed);
  });

  /** Waits until a backend of this database is blocked behind the given backend. */
  async function waitForBlocked(blockerPid: number) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const result = await db.execute(
        sql`select count(*)::int as n from pg_stat_activity
             where datname = current_database() and pid <> pg_backend_pid()
               and pg_blocking_pids(pid) @> array[${blockerPid}::int]`,
      );
      if (Number((result.rows[0] as { n: number }).n) >= 1) return;
      await Bun.sleep(10);
    }
    throw new Error(`Nothing became blocked behind pid ${blockerPid}`);
  }

  it("does not close again, or arm a terminate timer, for a peer that closed while its recheck ran", async () => {
    const { statusPage } = await liveFixture();
    const person = await api.register("Raw Editor");
    actors.set(person.session, actor(person));
    const live = openLive("rawLeak", statusPage, person.session);
    await received(live, "presence");
    expect((await api.request("POST", "/api/auth/logout", person.session)).status).toBe(200);

    // Terminate timers armed by live.ts, tracked by their delay, and still pending.
    const pending = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
      const timer = realSet(handler, ms);
      if (ms === leakTerminateAfterMs) pending.add(timer);
      return timer;
    }) as unknown as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: unknown) => {
      pending.delete(timer);
      return realClear(timer as never);
    }) as unknown as typeof clearTimeout);
    try {
      await db.transaction(async (tx) => {
        // The recheck that follows the canvas change reads the session, and waits for this lock.
        await tx.execute(sql`lock table sessions in access exclusive mode`);
        const holder = await tx.execute(sql`select pg_backend_pid() as pid`);
        const holderPid = Number((holder.rows[0] as { pid: number }).pid);
        expect((await patch("rawLeak", statusPage)).status).toBe(200);
        await waitForBlocked(holderPid);
        live.socket.close();
        await live.closed;
      });
      // The recheck now finds no access for a peer that is already gone.
      await Bun.sleep(200);
      expect([...pending]).toEqual([]);
    } finally {
      clear.mockRestore();
      set.mockRestore();
    }
  });

  it("closes the peers of a workspace when the canvas lookup for a member change fails", async () => {
    const { owner, payments } = await liveFixture();
    const members = `/api/workspaces/${owner.workspaceId}/members`;
    const manager = await api.register("Live Manager");
    expect(
      (await api.request("POST", members, owner.session, { email: manager.user.email, role: "manager" })).status,
    ).toBe(201);
    const managerLive = openLive("guarded", payments, manager.session);
    await received(managerLive, "presence");
    const ownerLive = openLive("guarded", payments, owner.session);
    await received(ownerLive, "presence");
    await received(managerLive, "joined");

    // The only query that selects a bare canvases.id for a signed-in request here is the lookup.
    const original = db.select.bind(db);
    let armed = true;
    const select = spyOn(db, "select").mockImplementation(((fields?: unknown) => {
      const probe = fields as { id?: unknown } | undefined;
      if (armed && probe && Object.keys(probe).length === 1 && probe.id === canvases.id) {
        armed = false;
        throw new Error("database unavailable");
      }
      return original(fields as never);
    }) as unknown as typeof db.select);
    try {
      const demotion = await api.request("PATCH", `${members}/${manager.user.id}`, owner.session, { role: "member" });
      expect(demotion.status).toBe(200);
      // The recheck runs after the response resolves.
      await waitFor(() => !armed);

      const closed = await closedWithin(managerLive);
      expect(closed?.code === 1008 || closed?.code === 1011).toBe(true);
      expect(types(managerLive)).toEqual(["presence", "joined"].slice(0, types(managerLive).length));
      const afterClose = [...managerLive.messages];
      // The owner was rechecked too, stays connected, and keeps being served.
      expect(await closedWithin(ownerLive, 200)).toBeNull();
      expect(await received(ownerLive, "left")).toMatchObject({ type: "left" });
      expect(await upgradeStatus(payments, owner.session)).toBe(400);
      expect((await api.request("PATCH", `/api/canvases/${payments}`, owner.session, { name: "Again" })).status).toBe(
        200,
      );
      expect(await received(ownerLive, "graph:changed")).toMatchObject({ type: "graph:changed" });
      expect(managerLive.messages).toEqual(afterClose);
    } finally {
      select.mockRestore();
    }
  });
});
