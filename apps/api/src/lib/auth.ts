import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { Elysia } from "elysia";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { canvasIdParamsSchema, connectionIdParamsSchema, entityIdParamsSchema } from "@wooble/contracts";
import {
  canvasConnections,
  canvasMembers,
  canvasNodes,
  canvases,
  connections,
  db,
  entities,
  sessions,
  workspaceMembers,
} from "@wooble/db";
import type { ReplyContext } from "./http-error";
import { allowedWebOrigins } from "./web-origins";

const scrypt = promisify(scryptCallback);
const COOKIE = "wooble_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 14;
const allowedOrigins = new Set(allowedWebOrigins);
const uuidSchema = z.string().uuid();

export type Actor = { id: string; name: string; email: string; systemRole: "admin" | "user" };

export type Api = Elysia<
  "",
  {
    decorator: { actor: Actor | null };
    store: Record<string, unknown>;
    derive: Record<string, unknown>;
    resolve: Record<string, unknown>;
  }
>;

export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) throw new Error("Authenticated actor is required");
  return actor;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [, salt, hex] = stored.split(":");
  if (!salt || !hex || stored.split(":").length !== 3) return false;
  const actual = Buffer.from(hex, "hex");
  if (actual.length !== 64) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, derived);
}
export function sessionCookie(token: string, maxAge = SESSION_AGE_SECONDS) {
  const localHttp = process.env.WEB_ORIGIN?.split(",").every((origin) => {
    try {
      const url = new URL(origin.trim());
      return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    } catch {
      return false;
    }
  });
  const secure = process.env.NODE_ENV === "production" && !localHttp ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
export async function createSession(userId: string, reply: ReplyContext) {
  const token = newToken();
  await db
    .insert(sessions)
    .values({ tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + SESSION_AGE_SECONDS * 1000) });
  reply.set.headers["set-cookie"] = sessionCookie(token);
}
export function sessionToken(cookieHeader: string | null | undefined) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}
export function clientIp(context: {
  server: { requestIP(request: Request): { address: string } | null } | null;
  request: Request;
}): string {
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = context.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return context.server?.requestIP(context.request)?.address ?? "127.0.0.1";
}
export async function workspaceRole(actor: Actor, workspaceId: string): Promise<"manager" | "member" | null> {
  if (actor.systemRole === "admin") return "manager";
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.id)))
    .limit(1);
  return row?.role ?? null;
}
export async function canvasRole(actor: Actor, canvasId: string): Promise<"manager" | "editor" | "viewer" | null> {
  const [canvas] = await db
    .select({ workspaceId: canvases.workspaceId, shareMode: canvases.shareMode })
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .limit(1);
  if (!canvas) return null;
  const workspace = await workspaceRole(actor, canvas.workspaceId);
  if (workspace === "manager") return "manager";
  const [row] = await db
    .select({ role: canvasMembers.role })
    .from(canvasMembers)
    .where(and(eq(canvasMembers.canvasId, canvasId), eq(canvasMembers.userId, actor.id)))
    .limit(1);
  return row?.role ?? (canvas.shareMode === "link" ? "viewer" : null);
}

export async function materializeLinkViewer(actor: Actor, canvasId: string): Promise<void> {
  const [canvas] = await db
    .select({ shareMode: canvases.shareMode })
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .limit(1);
  if (canvas?.shareMode !== "link") return;
  const [existing] = await db
    .select({ userId: canvasMembers.userId })
    .from(canvasMembers)
    .where(and(eq(canvasMembers.canvasId, canvasId), eq(canvasMembers.userId, actor.id)))
    .limit(1);
  if (existing) return;
  await db.insert(canvasMembers).values({ canvasId, userId: actor.id, role: "viewer" }).onConflictDoNothing();
}

export type ObjectKind = "entity" | "connection";

/** Whether the canvas shows the entity (placement) or connection (link). */
export async function objectOnCanvas(kind: ObjectKind, objectId: string, canvasId: string): Promise<boolean> {
  const [row] =
    kind === "entity"
      ? await db
          .select({ canvasId: canvasNodes.canvasId })
          .from(canvasNodes)
          .where(and(eq(canvasNodes.canvasId, canvasId), eq(canvasNodes.entityId, objectId)))
          .limit(1)
      : await db
          .select({ canvasId: canvasConnections.canvasId })
          .from(canvasConnections)
          .where(and(eq(canvasConnections.canvasId, canvasId), eq(canvasConnections.connectionId, objectId)))
          .limit(1);
  return !!row;
}

async function linkSharedCanvas(canvasId: string) {
  const [canvas] = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.id, canvasId), eq(canvases.shareMode, "link")))
    .limit(1);
  return !!canvas;
}

/**
 * The access rule for an entity or connection, and for every route nested under it. Workspace
 * managers (and system admins) may read and write. Otherwise the canvases of the object's workspace
 * that show it decide: reading needs a role on one of them or one of them shared by link; writing
 * needs the editor role on all of them. "missing" means the object does not exist.
 */
export async function objectAccess(
  actor: Actor,
  kind: ObjectKind,
  objectId: string,
  mode: "read" | "write",
): Promise<"allowed" | "denied" | "missing"> {
  const [object] =
    kind === "entity"
      ? await db.select({ workspaceId: entities.workspaceId }).from(entities).where(eq(entities.id, objectId)).limit(1)
      : await db
          .select({ workspaceId: connections.workspaceId })
          .from(connections)
          .where(eq(connections.id, objectId))
          .limit(1);
  if (!object) return "missing";
  if ((await workspaceRole(actor, object.workspaceId)) === "manager") return "allowed";
  const canvasIds = (
    kind === "entity"
      ? await db
          .select({ canvasId: canvasNodes.canvasId })
          .from(canvasNodes)
          .innerJoin(canvases, eq(canvases.id, canvasNodes.canvasId))
          .where(and(eq(canvasNodes.entityId, objectId), eq(canvases.workspaceId, object.workspaceId)))
      : await db
          .select({ canvasId: canvasConnections.canvasId })
          .from(canvasConnections)
          .innerJoin(canvases, eq(canvases.id, canvasConnections.canvasId))
          .where(and(eq(canvasConnections.connectionId, objectId), eq(canvases.workspaceId, object.workspaceId)))
  ).map((row) => row.canvasId);
  if (!canvasIds.length) return "denied";
  const memberships = await db
    .select({ canvasId: canvasMembers.canvasId, role: canvasMembers.role })
    .from(canvasMembers)
    .where(and(eq(canvasMembers.userId, actor.id), inArray(canvasMembers.canvasId, canvasIds)));
  const roles = new Map(memberships.map((row) => [row.canvasId, row.role]));
  if (mode === "write") return canvasIds.every((id) => roles.get(id) === "editor") ? "allowed" : "denied";
  if (canvasIds.some((id) => roles.has(id))) return "allowed";
  const [shared] = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(inArray(canvases.id, canvasIds), eq(canvases.shareMode, "link")))
    .limit(1);
  return shared ? "allowed" : "denied";
}

const publicCanvasRoutes = new Set([
  "/api/canvases/:canvasId",
  "/api/canvases/:canvasId/graph",
  "/api/canvases/:canvasId/access",
  "/api/canvases/:canvasId/live",
]);

async function publicReadAllowed(
  route: string,
  params: Record<string, string | undefined>,
  method: string,
  canvasIdQuery: string | null,
) {
  if (method !== "GET") return false;
  if (publicCanvasRoutes.has(route)) {
    const parsed = canvasIdParamsSchema.safeParse(params);
    return parsed.success && (await linkSharedCanvas(parsed.data.canvasId));
  }
  // Routes nested under an entity are not public: a new anonymous read needs its own decision.
  if (route !== "/api/entities/:entityId") return false;
  const entity = entityIdParamsSchema.safeParse(params);
  const canvasId = canvasIdQuery ? uuidSchema.safeParse(canvasIdQuery) : null;
  if (!entity.success || !canvasId?.success) return false;
  return (
    (await linkSharedCanvas(canvasId.data)) && (await objectOnCanvas("entity", entity.data.entityId, canvasId.data))
  );
}
function unauthorized(message: string): never {
  throw Object.assign(new Error(message), { status: 401 });
}
function deny(): never {
  throw Object.assign(new Error("You do not have access to this resource"), { status: 403 });
}

/**
 * How `accessGuard` authorizes a registered route:
 * - auth: sign-in and registration, no session needed.
 * - profile, invitations: any signed-in user; the handler scopes to the actor or the token.
 * - admin: system admins only.
 * - workspaces, canvases: the collection lists or creates the actor's own; a single workspace or
 *   canvas, and every route nested under it, needs a role on it.
 * - live: the canvas read rule for the socket upgrade; live.ts checks it again when the socket opens.
 * - entities, connections: objectAccess, for the object and every route nested under it.
 * - health: outside /api and unguarded.
 * An /api route that matches no class is denied, with 403 when signed in and 401 otherwise. A new
 * route is classified here, and tests/route-access.test.ts lists every registered route's class.
 */
export type RouteAccess =
  | "auth"
  | "profile"
  | "invitations"
  | "admin"
  | "workspaces"
  | "canvases"
  | "live"
  | "entities"
  | "connections"
  | "health";

const exactRouteAccess = new Map<string, RouteAccess>([
  ["/health", "health"],
  ["/api/auth/login", "auth"],
  ["/api/auth/register", "auth"],
  ["/api/auth/me", "profile"],
  ["/api/auth/logout", "profile"],
  ["/api/auth/profile", "profile"],
  ["/api/auth/password", "profile"],
  ["/api/invitations/:token", "invitations"],
  ["/api/invitations/:token/accept", "invitations"],
  ["/api/workspaces", "workspaces"],
  ["/api/canvases", "canvases"],
  ["/api/canvases/:canvasId/live", "live"],
]);
const scopedRouteAccess: Array<[string, RouteAccess]> = [
  ["/api/admin", "admin"],
  ["/api/workspaces/:workspaceId", "workspaces"],
  ["/api/canvases/:canvasId", "canvases"],
  ["/api/entities/:entityId", "entities"],
  ["/api/connections/:connectionId", "connections"],
];

export function routeAccess(route: string): RouteAccess | null {
  const exact = exactRouteAccess.get(route);
  if (exact) return exact;
  return scopedRouteAccess.find(([base]) => route === base || route.startsWith(`${base}/`))?.[1] ?? null;
}

export function accessGuard() {
  return new Elysia({ name: "wooble-access-guard" })
    .decorate("actor", null as Actor | null)
    .onRequest(async (context) => {
      const path = new URL(context.request.url).pathname;
      if (path === "/health" || !path.startsWith("/api/")) return;
      if (!["GET", "HEAD", "OPTIONS"].includes(context.request.method)) {
        const origin = context.request.headers.get("origin");
        if (origin && !allowedOrigins.has(origin)) return deny();
      }
      if (path === "/api/auth/login" || path === "/api/auth/register") return;
      const mayBePublicRead =
        context.request.method === "GET" && (path.startsWith("/api/canvases/") || path.startsWith("/api/entities/"));
      const token = sessionToken(context.request.headers.get("cookie"));
      if (!token) {
        if (mayBePublicRead) return;
        unauthorized("Sign in to continue");
      }
      const [row] = await db
        .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
        .limit(1);
      if (!row) {
        if (mayBePublicRead) return;
        unauthorized("Session expired. Sign in again");
      }
      const { users } = await import("@wooble/db");
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email, systemRole: users.systemRole })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      if (!user) {
        if (mayBePublicRead) return;
        unauthorized("Sign in to continue");
      }
      context.actor = user;
    })
    .onBeforeHandle({ as: "global" }, async (context) => {
      // Decide by the registered route, not the request path, so no spelling of a path can match an
      // /api route and skip the guard.
      const route = context.route;
      if (!route.startsWith("/api/")) return;
      const access = routeAccess(route);
      if (access === "auth") return;
      const actor = context.actor;
      if (!actor) {
        const url = new URL(context.request.url);
        if (await publicReadAllowed(route, context.params, context.request.method, url.searchParams.get("canvasId")))
          return;
        unauthorized("Sign in to continue");
      }
      const method = context.request.method;
      // Elysia answers HEAD with the GET handler, so it reads like GET.
      const reads = method === "GET" || method === "HEAD";
      // Invalid params identify nothing, so they pass through and the handler answers 400. An entity
      // or connection that does not exist passes through to the handler's 404. A missing workspace
      // or canvas is denied like one without a role (admins get the workspace handler's 404).
      switch (access) {
        case "profile":
        case "invitations":
          return;
        case "admin":
          if (actor.systemRole !== "admin") deny();
          return;
        case "workspaces": {
          if (route === "/api/workspaces") return;
          const id = uuidSchema.safeParse(context.params.workspaceId);
          if (!id.success) return;
          const role = await workspaceRole(actor, id.data);
          if (!role || (!reads && role !== "manager")) deny();
          return;
        }
        case "canvases":
        case "live": {
          if (route === "/api/canvases") return;
          const parsed = canvasIdParamsSchema.safeParse(context.params);
          if (!parsed.success) return;
          const role = await canvasRole(actor, parsed.data.canvasId);
          const managerOnly =
            route.includes("/members") ||
            route.includes("/invitations") ||
            (route === "/api/canvases/:canvasId" && !reads);
          if (!role || (managerOnly && role !== "manager") || (!reads && role === "viewer")) deny();
          return;
        }
        case "entities":
        case "connections": {
          const parsed =
            access === "entities"
              ? entityIdParamsSchema.safeParse(context.params)
              : connectionIdParamsSchema.safeParse(context.params);
          if (!parsed.success) return;
          const id = "entityId" in parsed.data ? parsed.data.entityId : parsed.data.connectionId;
          const kind = access === "entities" ? "entity" : "connection";
          if ((await objectAccess(actor, kind, id, reads ? "read" : "write")) === "denied") deny();
          return;
        }
        default:
          // No access class: deny until the route is classified in routeAccess.
          deny();
      }
    });
}
