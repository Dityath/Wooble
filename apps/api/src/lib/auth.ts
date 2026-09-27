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
    if (!parsed.success) return false;
    const [canvas] = await db
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.id, parsed.data.canvasId), eq(canvases.shareMode, "link")))
      .limit(1);
    return !!canvas;
  }
  if (route !== "/api/entities/:entityId") return false;
  const entity = entityIdParamsSchema.safeParse(params);
  const canvasId = canvasIdQuery ? uuidSchema.safeParse(canvasIdQuery) : null;
  if (!entity.success || !canvasId?.success) return false;
  const [placement] = await db
    .select({ entityId: canvasNodes.entityId })
    .from(canvasNodes)
    .innerJoin(canvases, eq(canvases.id, canvasNodes.canvasId))
    .where(
      and(
        eq(canvasNodes.canvasId, canvasId.data),
        eq(canvasNodes.entityId, entity.data.entityId),
        eq(canvases.shareMode, "link"),
      ),
    )
    .limit(1);
  return !!placement;
}
function unauthorized(message: string): never {
  throw Object.assign(new Error(message), { status: 401 });
}
function deny(): never {
  throw Object.assign(new Error("You do not have access to this resource"), { status: 403 });
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
      const requestPath = new URL(context.request.url).pathname;
      const route = context.route;
      if (!requestPath.startsWith("/api/")) return;
      if (route === "/api/auth/login" || route === "/api/auth/register") return;
      const actor = context.actor;
      if (!actor) {
        const url = new URL(context.request.url);
        if (await publicReadAllowed(route, context.params, context.request.method, url.searchParams.get("canvasId")))
          return;
        unauthorized("Sign in to continue");
      }
      if (route.startsWith("/api/auth/") || route.startsWith("/api/invitations/")) return;
      if (route.startsWith("/api/admin/")) {
        if (actor.systemRole !== "admin") return deny();
        return;
      }
      if (route === "/api/workspaces" || route === "/api/canvases") return;
      const isWorkspaceRoute =
        route === "/api/workspaces/:workspaceId" || route.startsWith("/api/workspaces/:workspaceId/");
      if (isWorkspaceRoute) {
        const id = uuidSchema.safeParse(context.params.workspaceId);
        if (!id.success) return;
        const role = await workspaceRole(actor, id.data);
        if (!role || (context.request.method !== "GET" && role !== "manager")) return deny();
        return;
      }
      const isCanvasRoute = route === "/api/canvases/:canvasId" || route.startsWith("/api/canvases/:canvasId/");
      if (isCanvasRoute) {
        const parsed = canvasIdParamsSchema.safeParse(context.params);
        if (!parsed.success) return;
        const role = await canvasRole(actor, parsed.data.canvasId);
        const managerOnly =
          route.includes("/members") ||
          route.includes("/invitations") ||
          (route === "/api/canvases/:canvasId" && context.request.method !== "GET");
        if (!role || (managerOnly && role !== "manager") || (context.request.method !== "GET" && role === "viewer"))
          return deny();
        return;
      }
      const isEntityRoute = route === "/api/entities/:entityId";
      const isConnectionRoute = route === "/api/connections/:connectionId";
      if (isEntityRoute || isConnectionRoute) {
        let resourceId: string;
        if (isEntityRoute) {
          const parsed = entityIdParamsSchema.safeParse(context.params);
          if (!parsed.success) return;
          resourceId = parsed.data.entityId;
        } else {
          const parsed = connectionIdParamsSchema.safeParse(context.params);
          if (!parsed.success) return;
          resourceId = parsed.data.connectionId;
        }
        const [resource] = isEntityRoute
          ? await db
              .select({ workspaceId: entities.workspaceId })
              .from(entities)
              .where(eq(entities.id, resourceId))
              .limit(1)
          : await db
              .select({ workspaceId: connections.workspaceId })
              .from(connections)
              .where(eq(connections.id, resourceId))
              .limit(1);
        if (!resource) return;
        if ((await workspaceRole(actor, resource.workspaceId)) === "manager") return;
        const rows = isEntityRoute
          ? await db
              .select({ canvasId: canvasNodes.canvasId })
              .from(canvasNodes)
              .innerJoin(canvases, eq(canvases.id, canvasNodes.canvasId))
              .where(and(eq(canvasNodes.entityId, resourceId), eq(canvases.workspaceId, resource.workspaceId)))
          : await db
              .select({ canvasId: canvasConnections.canvasId })
              .from(canvasConnections)
              .innerJoin(canvases, eq(canvases.id, canvasConnections.canvasId))
              .where(
                and(eq(canvasConnections.connectionId, resourceId), eq(canvases.workspaceId, resource.workspaceId)),
              );
        if (!rows.length) return deny();
        const memberships = await db
          .select({ canvasId: canvasMembers.canvasId, role: canvasMembers.role })
          .from(canvasMembers)
          .where(
            and(
              eq(canvasMembers.userId, actor.id),
              inArray(
                canvasMembers.canvasId,
                rows.map((row) => row.canvasId),
              ),
            ),
          );
        const roles = new Map(memberships.map((row) => [row.canvasId, row.role]));
        const linkSharedCanvasIds =
          context.request.method === "GET"
            ? new Set(
                (
                  await db
                    .select({ id: canvases.id })
                    .from(canvases)
                    .where(
                      and(
                        inArray(
                          canvases.id,
                          rows.map((row) => row.canvasId),
                        ),
                        eq(canvases.shareMode, "link"),
                      ),
                    )
                ).map((row) => row.id),
              )
            : new Set<string>();
        if (
          context.request.method === "GET"
            ? !rows.some((row) => roles.has(row.canvasId) || linkSharedCanvasIds.has(row.canvasId))
            : rows.some((row) => roles.get(row.canvasId) !== "editor")
        )
          return deny();
        return;
      }
    });
}
