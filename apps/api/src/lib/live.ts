import type { ElysiaWS } from "elysia/ws";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { canvasIdParamsSchema, connectionIdParamsSchema, entityIdParamsSchema } from "@wooble/contracts";
import { canvasConnections, canvasNodes, canvases, db, sessions, users } from "@wooble/db";
import { canvasRole, hashToken, sessionToken, type Actor, type Api } from "./auth";
import { allowedWebOrigins } from "./web-origins";

type Cursor = { x: number; y: number };
type Selection = { kind: "node" | "connection"; id: string } | null;
type Peer = {
  id: string;
  name: string;
  colorIndex: number;
  actor: Actor | null;
  tokenHash: string | null;
  canvasId: string;
  socket: ElysiaWS;
  cursor: Cursor | null;
  selection: Selection;
  lastActiveAt: number;
  lastCursorAt: number;
  /** False until open() has checked access; messages wait in `queued` until then. */
  joined: boolean;
  queued: unknown[];
  recheckTimer: ReturnType<typeof setInterval> | null;
  revokeTimer: ReturnType<typeof setTimeout> | null;
  closed: Promise<void>;
  markClosed: () => void;
};
const peers = new WeakMap<object, Peer>();
const shutdownClosers = new WeakMap<object, (gracePeriodMs: number) => Promise<void>>();
const maxQueuedMessages = 16;
const uuidParam = z.string().uuid();
function send(peer: Peer, message: object) {
  if (peer.socket.readyState === 1) peer.socket.send(JSON.stringify(message));
}
function revoke(peer: Peer, reason = "Canvas access changed") {
  if (peer.revokeTimer) return;
  peer.socket.close(1008, reason);
  peer.revokeTimer = setTimeout(() => peer.socket.terminate(), 1000);
}

function ignoreOversizedMessages(socket: ElysiaWS) {
  // Elysia 1.4 parses JSON before the route's message callback. Wrap its per-socket
  // dispatcher so the limit applies to the bytes received, including JSON whitespace.
  const raw = socket.raw as typeof socket.raw & {
    data: {
      message?: (ws: typeof socket.raw, message: string | Uint8Array) => unknown;
    };
  };
  const dispatch = raw.data.message;
  if (!dispatch) throw new Error("WebSocket message dispatcher is unavailable");
  raw.data.message = (ws, message) => {
    const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
    if (size > 256) return;
    return dispatch(ws, message);
  };
}
async function canReadCanvas(peer: Peer, canvasId: string) {
  if (peer.actor) {
    if (!peer.tokenHash) return false;
    const [session] = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, peer.tokenHash), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (session?.userId !== peer.actor.id) return false;
    const [user] = await db
      .select({ systemRole: users.systemRole })
      .from(users)
      .where(eq(users.id, peer.actor.id))
      .limit(1);
    return !!user && !!(await canvasRole({ ...peer.actor, systemRole: user.systemRole }, canvasId));
  }
  const [shared] = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.id, canvasId), eq(canvases.shareMode, "link")))
    .limit(1);
  return !!shared;
}

export function liveRoutes(app: Api, recheckMs = 30_000) {
  const rooms = new Map<string, Set<Peer>>();
  // Every open socket, including those still waiting for their access check.
  const connected = new Set<Peer>();
  shutdownClosers.set(app, async (gracePeriodMs) => {
    const activePeers = [...connected];
    for (const peer of activePeers) {
      if (peer.recheckTimer) clearInterval(peer.recheckTimer);
      if (peer.revokeTimer) clearTimeout(peer.revokeTimer);
      try {
        if (peer.socket.readyState === 1) peer.socket.close(1001, "Server shutting down");
      } catch {
        peer.socket.terminate();
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(activePeers.map((peer) => peer.closed)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, gracePeriodMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    for (const peer of activePeers) if (peer.socket.readyState !== 3) peer.socket.terminate();
  });
  function broadcast(canvasId: string, message: object, except?: Peer) {
    for (const peer of rooms.get(canvasId) ?? []) if (peer !== except) send(peer, message);
  }
  /**
   * Takes a peer out of every live structure, so nothing reaches it and nothing it sends is relayed,
   * whether or not its socket has finished closing. The socket's close handler repeats this work,
   * and clearing `joined` here makes it idempotent.
   */
  function detach(peer: Peer) {
    if (!connected.delete(peer)) return;
    peer.queued = [];
    if (peer.recheckTimer) {
      clearInterval(peer.recheckTimer);
      peer.recheckTimer = null;
    }
    if (!peer.joined) return;
    peer.joined = false;
    const room = rooms.get(peer.canvasId);
    room?.delete(peer);
    broadcast(peer.canvasId, { type: "left", id: peer.id });
    if (room && !room.size) rooms.delete(peer.canvasId);
  }
  /** Access that cannot be established is no access: close the peer, and stop it first. */
  function unavailable(peer: Peer) {
    // Detach before the close handshake starts, otherwise frames still travel during the close window.
    detach(peer);
    if (peer.revokeTimer) return;
    peer.socket.close(1011, "Access check unavailable");
    // An unresponsive client must not keep a detached socket around.
    peer.revokeTimer = setTimeout(() => peer.socket.terminate(), 1000);
  }
  async function revalidatePeers(affected: (peer: Peer) => boolean) {
    // Checked in parallel, and one failed check does not stop the rest. A peer whose access cannot be
    // read fails closed: it is detached and closed rather than left waiting for a later check.
    await Promise.all(
      [...connected].filter(affected).map(async (peer) => {
        try {
          if (!(await canReadCanvas(peer, peer.canvasId))) revoke(peer);
        } catch (error) {
          console.error("Could not recheck live canvas access", error);
          unavailable(peer);
        }
      }),
    );
  }
  const closeRevokedPeers = (canvasId: string) => revalidatePeers((peer) => peer.canvasId === canvasId);
  /** Rechecks the user's sockets after a sign-out, a password change, or a system role change. */
  const revalidateLivePeers = (userId: string) => revalidatePeers((peer) => peer.actor?.id === userId);
  async function revalidateWorkspacePeers(workspaceId: string) {
    if (!connected.size) return;
    const rows = await db.select({ id: canvases.id }).from(canvases).where(eq(canvases.workspaceId, workspaceId));
    const canvasIds = new Set(rows.map((row) => row.id));
    await revalidatePeers((peer) => canvasIds.has(peer.canvasId));
  }

  async function join(peer: Peer) {
    let allowed: boolean;
    try {
      allowed = await canReadCanvas(peer, peer.canvasId);
    } catch (error) {
      console.error("Could not check live canvas access", error);
      unavailable(peer);
      return;
    }
    // The socket may have closed, or been revoked, while the check ran.
    if (!connected.has(peer) || peer.socket.readyState !== 1) return;
    if (!allowed) {
      revoke(peer, "Canvas access denied");
      return;
    }
    const room = rooms.get(peer.canvasId) ?? new Set<Peer>();
    const usedColors = new Set([...room].map((member) => member.colorIndex));
    peer.colorIndex = [0, 1, 2, 3, 4, 5].find((index) => !usedColors.has(index)) ?? room.size % 6;
    rooms.set(peer.canvasId, room);
    send(peer, {
      type: "presence",
      peers: [...room].map(({ id, name, colorIndex, cursor, selection, lastActiveAt }) => ({
        id,
        name,
        colorIndex,
        cursor,
        selection,
        lastActiveAt,
      })),
    });
    room.add(peer);
    peer.joined = true;
    broadcast(
      peer.canvasId,
      { type: "joined", id: peer.id, name: peer.name, colorIndex: peer.colorIndex, lastActiveAt: peer.lastActiveAt },
      peer,
    );
    peer.recheckTimer = setInterval(async () => {
      try {
        if (await canReadCanvas(peer, peer.canvasId)) return;
        revoke(peer);
      } catch (error) {
        console.error("Could not recheck live canvas access", error);
        unavailable(peer);
      }
    }, recheckMs);
    for (const message of peer.queued.splice(0)) receive(peer, message);
  }

  function receive(peer: Peer, message: unknown) {
    const raw =
      typeof message === "string"
        ? message
        : message instanceof Uint8Array
          ? new TextDecoder().decode(message)
          : JSON.stringify(message);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
    if (parsed.type === "selection") {
      const { kind, id } = parsed as { kind?: unknown; id?: unknown };
      if (
        kind !== null &&
        ((kind !== "node" && kind !== "connection") || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      )
        return;
      peer.selection = kind === null ? null : { kind, id: id as string };
      peer.lastActiveAt = Date.now();
      broadcast(
        peer.canvasId,
        { type: "selection", id: peer.id, selection: peer.selection, lastActiveAt: peer.lastActiveAt },
        peer,
      );
      return;
    }
    if (parsed.type === "activity") {
      peer.lastActiveAt = Date.now();
      broadcast(peer.canvasId, { type: "activity", id: peer.id, lastActiveAt: peer.lastActiveAt }, peer);
      return;
    }
    if (parsed.type !== "cursor") return;
    const { x, y } = parsed as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 || Date.now() - peer.lastCursorAt < 40) return;
    peer.lastCursorAt = Date.now();
    peer.cursor = { x, y };
    peer.lastActiveAt = Date.now();
    broadcast(
      peer.canvasId,
      { type: "cursor", id: peer.id, name: peer.name, x, y, lastActiveAt: peer.lastActiveAt },
      peer,
    );
  }

  app.ws("/api/canvases/:canvasId/live", {
    open(socket) {
      const data = socket.data as {
        params: { canvasId: string };
        headers: Record<string, string | undefined>;
        actor: Actor | null;
      };
      // accessGuard lets invalid params through, so validate the ID as the canvas routes do.
      const params = canvasIdParamsSchema.safeParse(data.params);
      if (!params.success || !allowedWebOrigins.includes(data.headers.origin ?? "")) {
        socket.close(1008, "Invalid canvas or origin");
        return;
      }
      const canvasId = params.data.canvasId;
      ignoreOversizedMessages(socket);
      const id = crypto.randomUUID();
      const token = sessionToken(data.headers.cookie);
      let markClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const peer: Peer = {
        id,
        name: data.actor?.name.slice(0, 32) ?? `Guest ${id.slice(0, 4).toUpperCase()}`,
        colorIndex: 0,
        actor: data.actor,
        tokenHash: data.actor && token ? hashToken(token) : null,
        canvasId,
        socket,
        cursor: null,
        selection: null,
        lastActiveAt: Date.now(),
        lastCursorAt: 0,
        joined: false,
        queued: [],
        recheckTimer: null,
        revokeTimer: null,
        closed,
        markClosed,
      };
      peers.set(socket.raw, peer);
      connected.add(peer);
      // The upgrade already passed accessGuard; check again here so a socket whose access ended
      // in between never joins the room or sees presence.
      return join(peer);
    },
    message(ws, message) {
      const peer = peers.get(ws.raw);
      if (!peer) return;
      if (peer.joined) receive(peer, message);
      else if (peer.queued.length < maxQueuedMessages) peer.queued.push(message);
    },
    close(ws) {
      const peer = peers.get(ws.raw);
      if (!peer) return;
      peers.delete(ws.raw);
      detach(peer);
      if (peer.revokeTimer) clearTimeout(peer.revokeTimer);
      peer.markClosed();
    },
  });

  app.onAfterResponse(async (context) => {
    const method = context.request.method;
    const status = typeof context.set.status === "number" ? context.set.status : 200;
    if (["GET", "HEAD", "OPTIONS"].includes(method) || status >= 400) return;
    const route = context.route;
    // Signing out, a password change (which ends every session), a system role change and a
    // workspace member change can end access outside the canvas routes below. Recheck the affected
    // sockets now rather than at the next interval.
    const revokedUserId =
      route === "/api/auth/logout" || route === "/api/auth/password"
        ? context.actor?.id
        : route === "/api/admin/users/:userId"
          ? context.params.userId
          : undefined;
    const workspaceParams = route.startsWith("/api/workspaces/:workspaceId/members")
      ? uuidParam.safeParse(context.params.workspaceId)
      : null;
    if (revokedUserId || workspaceParams?.success) {
      try {
        if (revokedUserId) await revalidateLivePeers(revokedUserId);
        if (workspaceParams?.success) await revalidateWorkspacePeers(workspaceParams.data);
      } catch (error) {
        console.error("Could not recheck live canvas access", error);
      }
      return;
    }
    const canvasParams = canvasIdParamsSchema.safeParse(context.params);
    if (route.startsWith("/api/canvases/:canvasId/") || route === "/api/canvases/:canvasId") {
      if (!canvasParams.success) return;
      const canvasId = canvasParams.data.canvasId;
      if (method === "DELETE" || method === "PATCH" || route.includes("/members")) {
        try {
          await closeRevokedPeers(canvasId);
        } catch (error) {
          console.error("Could not recheck live canvas access", error);
        }
      }
      broadcast(canvasId, { type: "graph:changed" });
      return;
    }
    const entityRoute = route === "/api/entities/:entityId";
    const connectionRoute = route === "/api/connections/:connectionId";
    const entityParams = entityRoute ? entityIdParamsSchema.safeParse(context.params) : null;
    const connectionParams = connectionRoute ? connectionIdParamsSchema.safeParse(context.params) : null;
    if ((entityParams && !entityParams.success) || (connectionParams && !connectionParams.success)) return;
    try {
      const rows = entityParams?.success
        ? await db
            .select({ canvasId: canvasNodes.canvasId })
            .from(canvasNodes)
            .where(eq(canvasNodes.entityId, entityParams.data.entityId))
        : connectionParams?.success
          ? await db
              .select({ canvasId: canvasConnections.canvasId })
              .from(canvasConnections)
              .where(eq(canvasConnections.connectionId, connectionParams.data.connectionId))
          : [];
      for (const id of new Set(rows.map((row) => row.canvasId))) broadcast(id, { type: "graph:changed" });
    } catch (error) {
      console.error("Could not broadcast canvas change", error);
    }
  });
}

export async function closeLivePeers(app: unknown, gracePeriodMs = 2_000) {
  await shutdownClosers.get(app as object)?.(gracePeriodMs);
}

export async function stopLiveServer(app: Api, gracePeriodMs = 2_000) {
  const server = app.server;
  if (!server) return;
  await closeLivePeers(app, gracePeriodMs);
  const stopped = server.stop();
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const forced = new Promise<void>((resolve, reject) => {
    forceTimer = setTimeout(() => void server.stop(true).then(resolve, reject), gracePeriodMs);
  });
  try {
    await Promise.race([stopped, forced]);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
  }
}
