import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, users } from "@wooble/db";
import { createApp } from "../src/app";
import { stopLiveServer } from "../src/lib/live";
import { resetLoginAttempts } from "../src/modules/auth/routes";

const password = "WoobleTestPassword-2026";
const unique = crypto.randomUUID().slice(0, 8);
const app = createApp({ liveRecheckMs: 100 });
let serverStopped = false;

beforeAll(() => {
  resetLoginAttempts();
});

afterAll(async () => {
  if (!serverStopped) await app.server?.stop(true);
});

function cookie(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}
async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  session?: string,
  payload?: unknown,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
  );
}
async function register(name: string) {
  const email = `${name.toLowerCase()}-${unique}@example.test`;
  const result = await request("POST", "/api/auth/register", undefined, {
    name,
    email,
    password,
    confirmPassword: password,
  });
  expect(result.status).toBe(201);
  return {
    user: (await result.json()) as { id: string; email: string },
    session: cookie(result) as string,
  };
}

test("sessions, personal workspaces, separate canvas roles, links, and admin", async () => {
  expect((await request("GET", "/api/workspaces")).status).toBe(401);
  const mismatched = await request("POST", "/api/auth/register", undefined, {
    name: "Mismatch",
    email: `mismatch-${unique}@example.test`,
    password,
    confirmPassword: "DifferentPassword-2026",
  });
  expect(mismatched.status).toBe(400);
  expect(await mismatched.json()).toEqual({ error: "bad_request", message: "Passwords do not match" });
  const owner = await register("Owner");
  const viewer = await register("Viewer");
  const editor = await register("Editor");
  const guest = await register("Guest");
  const ownerWorkspaces = (await (await request("GET", "/api/workspaces", owner.session)).json()) as Array<{
    id: string;
    name: string;
    role: string;
  }>;
  const viewerWorkspaces = (await (await request("GET", "/api/workspaces", viewer.session)).json()) as Array<{
    id: string;
    name: string;
  }>;
  expect(ownerWorkspaces).toHaveLength(1);
  expect(ownerWorkspaces[0]).toMatchObject({ name: "My Workspace", role: "manager" });
  expect(viewerWorkspaces[0].id).not.toBe(ownerWorkspaces[0].id);
  const workspaceId = ownerWorkspaces[0].id;
  const created = await request("POST", "/api/canvases", owner.session, {
    workspaceId,
    name: "Shared map",
    description: "",
  });
  expect(created.status).toBe(201);
  const canvasId = ((await created.json()) as { id: string }).id;
  expect((await request("GET", `/api/canvases/${canvasId}/graph`, viewer.session)).status).toBe(403);
  expect(
    (await request("POST", "/api/canvases", viewer.session, { workspaceId, name: "Denied", description: "" })).status,
  ).toBe(403);
  const viewerInvite = await request("POST", `/api/canvases/${canvasId}/invitations`, owner.session, {
    role: "viewer",
  });
  expect(viewerInvite.status).toBe(201);
  const viewerToken = ((await viewerInvite.json()) as { token: string }).token;
  expect((await request("POST", `/api/invitations/${viewerToken}/accept`, viewer.session)).status).toBe(200);
  expect((await request("POST", `/api/invitations/${viewerToken}/accept`, editor.session)).status).toBe(404);
  expect((await request("GET", `/api/canvases/${canvasId}/graph`, viewer.session)).status).toBe(200);
  expect(
    ((await (await request("GET", `/api/canvases/${canvasId}/access`, viewer.session)).json()) as { role: string })
      .role,
  ).toBe("viewer");
  expect(
    (await request("PUT", `/api/canvases/${canvasId}/placements`, viewer.session, { placements: [] })).status,
  ).toBe(403);
  expect(
    (
      await request("POST", `/api/canvases/${canvasId}/members`, viewer.session, {
        email: editor.user.email,
        role: "editor",
      })
    ).status,
  ).toBe(403);
  const editorInvite = await request("POST", `/api/canvases/${canvasId}/invitations`, owner.session, {
    role: "editor",
  });
  const editorToken = ((await editorInvite.json()) as { token: string }).token;
  expect((await request("POST", `/api/invitations/${editorToken}/accept`, editor.session)).status).toBe(200);
  expect(
    ((await (await request("GET", `/api/canvases/${canvasId}/access`, editor.session)).json()) as { role: string })
      .role,
  ).toBe("editor");
  const node = await request("POST", `/api/canvases/${canvasId}/entities`, editor.session, {
    type: "service",
    name: "Auth",
    x: 0,
    y: 0,
    parentEntityId: null,
  });
  expect(node.status).toBe(201);
  const nodeId = ((await node.json()) as { id: string }).id;
  expect((await request("PATCH", `/api/entities/${nodeId}`, viewer.session, { name: "Unsafe" })).status).toBe(403);
  expect((await request("PATCH", `/api/entities/${nodeId}`, editor.session, { name: "Updated" })).status).toBe(200);
  expect((await request("GET", `/api/canvases/${canvasId}/graph`, guest.session)).status).toBe(403);
  expect((await request("PATCH", `/api/canvases/${canvasId}`, guest.session, { shareMode: "link" })).status).toBe(403);
  expect((await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "invalid" })).status).toBe(
    400,
  );
  expect((await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "link" })).status).toBe(200);
  expect((await request("GET", `/api/canvases/${canvasId}/graph`)).status).toBe(200);
  expect(((await (await request("GET", `/api/canvases/${canvasId}/access`)).json()) as { role: string }).role).toBe(
    "viewer",
  );
  expect((await request("GET", `/api/canvases/${canvasId}`)).status).toBe(200);
  expect((await request("GET", `/api/entities/${nodeId}?canvasId=${canvasId}`)).status).toBe(200);
  expect((await request("GET", `/api/entities/${nodeId}`)).status).toBe(401);
  expect((await request("GET", `/api/canvases/${canvasId}/members`)).status).toBe(401);
  expect((await request("PUT", `/api/canvases/${canvasId}/placements`, undefined, { placements: [] })).status).toBe(
    401,
  );
  await app.listen({ hostname: "127.0.0.1", port: 0 });
  const address = app.server?.url.origin;
  if (!address) throw new Error("Server did not start");
  const openSocket = (session?: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${address.replace(/^http/, "ws")}/api/canvases/${canvasId}/live`, {
        headers: { origin: "http://localhost:5173", ...(session ? { cookie: session } : {}) },
      });
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
  const firstGuestSocket = await openSocket();
  const secondGuestSocket = await openSocket();
  const nextMessage = (type: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type !== type) return;
        clearTimeout(timer);
        secondGuestSocket.removeEventListener("message", listener);
        resolve(message);
      };
      secondGuestSocket.addEventListener("message", listener);
    });
  try {
    const thirdSocket = new WebSocket(`${address.replace(/^http/, "ws")}/api/canvases/${canvasId}/live`, {
      headers: { origin: "http://localhost:5173" },
    });
    const thirdPresence = await new Promise<{ peers: Array<{ colorIndex: number }> }>((resolve, reject) => {
      thirdSocket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; peers: Array<{ colorIndex: number }> };
        if (message.type === "presence") resolve(message);
      });
      thirdSocket.addEventListener("error", () => reject(new Error("Third live connection failed")), { once: true });
    });
    expect(new Set(thirdPresence.peers.map((peer) => peer.colorIndex)).size).toBe(2);
    thirdSocket.close();
    const cursorMessage = nextMessage("cursor");
    firstGuestSocket.send(JSON.stringify({ type: "cursor", x: 82, y: 64 }));
    const cursor = await cursorMessage;
    expect(cursor).toMatchObject({ type: "cursor", x: 82, y: 64 });
    expect(cursor.name).toMatch(/^Guest [0-9A-F]{4}$/);
    const selectionMessage = nextMessage("selection");
    firstGuestSocket.send(JSON.stringify({ type: "selection", kind: "node", id: nodeId }));
    expect(await selectionMessage).toMatchObject({ type: "selection", selection: { kind: "node", id: nodeId } });
    const activityMessage = nextMessage("activity");
    firstGuestSocket.send(JSON.stringify({ type: "activity" }));
    expect(await activityMessage).toMatchObject({ type: "activity" });
    await Bun.sleep(60);
    const boundedCursor = nextMessage("cursor");
    firstGuestSocket.send(`${JSON.stringify({ type: "cursor", x: 1, y: 1 })}${" ".repeat(300)}`);
    await Bun.sleep(60);
    firstGuestSocket.send(JSON.stringify({ type: "cursor", x: 83, y: 65 }));
    expect(await boundedCursor).toMatchObject({ type: "cursor", x: 83, y: 65 });
    const changeMessage = nextMessage("graph:changed");
    expect((await request("PATCH", `/api/entities/${nodeId}`, editor.session, { name: "Live change" })).status).toBe(
      200,
    );
    expect(await changeMessage).toMatchObject({ type: "graph:changed" });
    const graphBeforeMove = (await (
      await request("GET", `/api/canvases/${canvasId}/graph`, editor.session)
    ).json()) as {
      placements: Array<{
        entityId: string;
        parentEntityId: string | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    };
    const placement = graphBeforeMove.placements[0];
    const moveMessage = nextMessage("graph:changed");
    expect(
      (
        await request("PUT", `/api/canvases/${canvasId}/placements`, editor.session, {
          placements: [{ ...placement, x: placement.x + 20 }],
        })
      ).status,
    ).toBe(200);
    expect(await moveMessage).toMatchObject({ type: "graph:changed" });
    const unexpectedChange = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        secondGuestSocket.removeEventListener("message", listener);
        resolve(false);
      }, 100);
      const listener = (event: MessageEvent) => {
        if ((JSON.parse(String(event.data)) as { type?: string }).type !== "graph:changed") return;
        clearTimeout(timer);
        secondGuestSocket.removeEventListener("message", listener);
        resolve(true);
      };
      secondGuestSocket.addEventListener("message", listener);
    });
    expect((await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "invalid" })).status).toBe(
      400,
    );
    expect(await unexpectedChange).toBe(false);
    const revoked = new Promise<number>((resolve) => {
      secondGuestSocket.addEventListener("close", (event) => resolve(event.code), { once: true });
    });
    expect(
      (await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "restricted" })).status,
    ).toBe(200);
    expect(await Promise.race([revoked, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1500))])).toBe(
      1008,
    );
    expect((await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "link" })).status).toBe(
      200,
    );
  } finally {
    firstGuestSocket.close();
    secondGuestSocket.close();
  }
  const linkedGraph = await request("GET", `/api/canvases/${canvasId}/graph`, guest.session);
  expect(linkedGraph.status).toBe(200);
  expect(((await linkedGraph.json()) as { canvas: { shareMode: string } }).canvas.shareMode).toBe("link");
  expect(
    ((await (await request("GET", `/api/canvases/${canvasId}/access`, guest.session)).json()) as { role: string }).role,
  ).toBe("viewer");
  const membersAfterVisit = (await (
    await request("GET", `/api/canvases/${canvasId}/members`, owner.session)
  ).json()) as Array<{ id: string; role: string }>;
  expect(membersAfterVisit.find((member) => member.id === guest.user.id)).toMatchObject({ role: "viewer" });
  expect(
    ((await (await request("GET", `/api/canvases/${canvasId}/access`, editor.session)).json()) as { role: string })
      .role,
  ).toBe("editor");
  expect((await request("GET", `/api/entities/${nodeId}`, guest.session)).status).toBe(200);
  expect((await request("PATCH", `/api/entities/${nodeId}`, guest.session, { name: "Denied" })).status).toBe(403);
  expect((await request("GET", `/api/canvases/${canvasId}/members`, guest.session)).status).toBe(403);
  expect((await request("PUT", `/api/canvases/${canvasId}/placements`, guest.session, { placements: [] })).status).toBe(
    403,
  );
  expect((await request("PATCH", `/api/canvases/${canvasId}`, owner.session, { shareMode: "restricted" })).status).toBe(
    200,
  );
  expect((await request("GET", `/api/canvases/${canvasId}/graph`, guest.session)).status).toBe(200);
  expect((await request("GET", `/api/canvases/${canvasId}/graph`)).status).toBe(401);
  expect((await request("GET", `/api/entities/${nodeId}?canvasId=${canvasId}`)).status).toBe(401);
  expect(
    ((await (await request("GET", `/api/workspaces/${workspaceId}`, viewer.session)).json()) as { canvasCount: number })
      .canvasCount,
  ).toBe(1);
  const emptyWorkspace = await request("POST", "/api/workspaces", owner.session, {
    name: "Empty team",
    description: "",
  });
  expect(emptyWorkspace.status).toBe(201);
  const emptyWorkspaceId = ((await emptyWorkspace.json()) as { id: string }).id;
  const workspaceInvite = await request("POST", `/api/workspaces/${emptyWorkspaceId}/invitations`, owner.session);
  expect(
    (
      await request(
        "POST",
        `/api/invitations/${((await workspaceInvite.json()) as { token: string }).token}/accept`,
        guest.session,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      (await (await request("GET", `/api/workspaces/${emptyWorkspaceId}`, guest.session)).json()) as {
        canvasCount: number;
      }
    ).canvasCount,
  ).toBe(0);
  expect(
    (
      await request("POST", "/api/canvases", guest.session, {
        workspaceId: emptyWorkspaceId,
        name: "Denied",
        description: "",
      })
    ).status,
  ).toBe(403);
  expect(
    (await request("DELETE", `/api/workspaces/${workspaceId}/members/${viewer.user.id}`, owner.session)).status,
  ).toBe(200);
  expect((await request("GET", `/api/canvases/${canvasId}/graph`, viewer.session)).status).toBe(403);
  expect((await request("GET", "/api/admin/users", viewer.session)).status).toBe(403);
  await db.update(users).set({ systemRole: "admin" }).where(eq(users.id, owner.user.id));
  expect((await request("GET", "/api/admin/users", owner.session)).status).toBe(200);
  expect(
    ((await (await request("GET", "/api/workspaces", owner.session)).json()) as unknown[]).length,
  ).toBeGreaterThanOrEqual(5);
  expect((await request("POST", "/api/auth/logout", viewer.session)).status).toBe(200);
  expect((await request("GET", "/api/auth/me", viewer.session)).status).toBe(401);
  const ownerSocket = await openSocket(owner.session);
  const ownerRevoked = new Promise<number>((resolve) => {
    ownerSocket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  expect((await request("POST", "/api/auth/logout", owner.session)).status).toBe(200);
  expect(await Promise.race([ownerRevoked, Bun.sleep(1_000).then(() => -1)])).toBe(1008);
  const editorSocket = await openSocket(editor.session);
  const serverClosed = new Promise<{ code: number; reason: string }>((resolve) => {
    editorSocket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), {
      once: true,
    });
  });
  await stopLiveServer(app);
  serverStopped = true;
  // Bun 1.3.14 maps an incoming 1001 frame to code 1000; retain the close reason check.
  expect(await Promise.race([serverClosed, Bun.sleep(1_000).then(() => null)])).toEqual({
    code: 1000,
    reason: "Server shutting down",
  });
}, 20_000);
