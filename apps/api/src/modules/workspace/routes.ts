import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, workspaceMembers, workspaces, users, canvases, canvasMembers, invitations } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import { requireActor, hashToken, newToken, workspaceRole, type Api } from "../../lib/auth";

const idParams = z.object({ workspaceId: z.string().uuid() });
const memberParams = idParams.extend({ userId: z.string().uuid() });
const workspaceInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
});
const memberInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  role: z.enum(["manager", "member"]),
});
const roleInput = z.object({ role: z.enum(["manager", "member"]) });

export function workspaceRoutes(app: Api) {
  app.get("/api/workspaces", async (context) => {
    const actor = requireActor(context.actor);
    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, actor.id));
    const roles = new Map(memberships.map((row) => [row.workspaceId, row.role]));
    const rows =
      actor.systemRole === "admin"
        ? await db.select().from(workspaces).orderBy(asc(workspaces.name))
        : roles.size
          ? await db
              .select()
              .from(workspaces)
              .where(inArray(workspaces.id, [...roles.keys()]))
              .orderBy(asc(workspaces.name))
          : [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
      role: actor.systemRole === "admin" ? "manager" : roles.get(row.id),
    }));
  });
  app.post("/api/workspaces", async (context) => {
    const parsed = workspaceInput.safeParse(context.body);
    if (!parsed.success) return badRequest(context, parsed.error.issues[0]?.message ?? "Invalid workspace");
    const row = await db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values(parsed.data).returning();
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: requireActor(context.actor).id, role: "manager" });
      return workspace;
    });
    context.set.status = 201;
    return { ...row, updatedAt: row.updatedAt.toISOString(), role: "manager" };
  });
  app.get("/api/workspaces/:workspaceId", async (context) => {
    const parsed = idParams.safeParse(context.params);
    if (!parsed.success) return badRequest(context, "Workspace ID must be a UUID");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, parsed.data.workspaceId)).limit(1);
    if (!row) return notFound(context, "Workspace not found");
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(canvases)
      .where(eq(canvases.workspaceId, row.id));
    return {
      ...row,
      canvasCount: count,
      updatedAt: row.updatedAt.toISOString(),
      role: await workspaceRole(requireActor(context.actor), row.id),
    };
  });
  app.patch("/api/workspaces/:workspaceId", async (context) => {
    const params = idParams.safeParse(context.params);
    const body = workspaceInput.partial().safeParse(context.body);
    if (!params.success) return badRequest(context, "Workspace ID must be a UUID");
    if (!body.success || !Object.keys(body.data).length) return badRequest(context, "Invalid workspace");
    const [row] = await db
      .update(workspaces)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(workspaces.id, params.data.workspaceId))
      .returning();
    if (!row) return notFound(context, "Workspace not found");
    return { ...row, updatedAt: row.updatedAt.toISOString(), role: "manager" };
  });
  app.get("/api/workspaces/:workspaceId/members", async (context) => {
    const params = idParams.safeParse(context.params);
    if (!params.success) return badRequest(context, "Workspace ID must be a UUID");
    return db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, params.data.workspaceId))
      .orderBy(asc(users.name));
  });
  app.post("/api/workspaces/:workspaceId/members", async (context) => {
    const params = idParams.safeParse(context.params);
    const body = memberInput.safeParse(context.body);
    if (!params.success) return badRequest(context, "Workspace ID must be a UUID");
    if (!body.success) return badRequest(context, "Invalid member");
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.data.email)).limit(1);
    if (!user) return notFound(context, "User must register before they can be added");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: params.data.workspaceId, userId: user.id, role: body.data.role })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: body.data.role },
      });
    context.set.status = 201;
    return { id: user.id, role: body.data.role };
  });
  app.patch("/api/workspaces/:workspaceId/members/:userId", async (context) => {
    const params = memberParams.safeParse(context.params);
    const body = roleInput.safeParse(context.body);
    if (!params.success || !body.success) return badRequest(context, "Invalid member role");
    const [member] = await db
      .update(workspaceMembers)
      .set({ role: body.data.role })
      .where(
        and(eq(workspaceMembers.workspaceId, params.data.workspaceId), eq(workspaceMembers.userId, params.data.userId)),
      )
      .returning();
    if (!member) return notFound(context, "Member not found");
    return { id: member.userId, role: member.role };
  });
  app.delete("/api/workspaces/:workspaceId/members/:userId", async (context) => {
    const params = memberParams.safeParse(context.params);
    if (!params.success) return badRequest(context, "Invalid member");
    if (params.data.userId === requireActor(context.actor).id)
      return badRequest(context, "You cannot remove yourself from a workspace you manage");
    await db.transaction(async (tx) => {
      const canvasIds = await tx
        .select({ id: canvases.id })
        .from(canvases)
        .where(eq(canvases.workspaceId, params.data.workspaceId));
      if (canvasIds.length)
        await tx.delete(canvasMembers).where(
          and(
            eq(canvasMembers.userId, params.data.userId),
            inArray(
              canvasMembers.canvasId,
              canvasIds.map((row) => row.id),
            ),
          ),
        );
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, params.data.workspaceId),
            eq(workspaceMembers.userId, params.data.userId),
          ),
        );
    });
    return { ok: true };
  });
  app.post("/api/workspaces/:workspaceId/invitations", async (context) => {
    const params = idParams.safeParse(context.params);
    if (!params.success) return badRequest(context, "Workspace ID must be a UUID");
    const token = newToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    await db.insert(invitations).values({
      tokenHash: hashToken(token),
      workspaceId: params.data.workspaceId,
      role: "member",
      createdBy: requireActor(context.actor).id,
      expiresAt,
    });
    context.set.status = 201;
    return { token, role: "member", expiresAt: expiresAt.toISOString() };
  });
}
