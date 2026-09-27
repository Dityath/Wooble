import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, invitations, workspaceMembers, canvasMembers, workspaces, canvases } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import { requireActor, hashToken, type Api } from "../../lib/auth";

const paramsSchema = z.object({ token: z.string().min(20).max(100) });
export function invitationRoutes(app: Api) {
  app.get("/api/invitations/:token", async (context) => {
    const params = paramsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Invalid invitation");
    const [invite] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, hashToken(params.data.token)), gt(invitations.expiresAt, new Date())))
      .limit(1);
    if (!invite || invite.remainingUses < 1) return notFound(context, "Invitation is unavailable or expired");
    const [workspace] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, invite.workspaceId))
      .limit(1);
    const [canvas] = invite.canvasId
      ? await db.select({ name: canvases.name }).from(canvases).where(eq(canvases.id, invite.canvasId)).limit(1)
      : [];
    return {
      workspaceName: workspace?.name,
      canvasName: canvas?.name,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
    };
  });
  app.post("/api/invitations/:token/accept", async (context) => {
    const params = paramsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Invalid invitation");
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hashToken(params.data.token)))
        .for("update")
        .limit(1);
      if (!invite || invite.expiresAt < new Date() || invite.remainingUses < 1) return null;
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId: requireActor(context.actor).id, role: "member" })
        .onConflictDoNothing();
      if (invite.canvasId && invite.role !== "member")
        await tx
          .insert(canvasMembers)
          .values({ canvasId: invite.canvasId, userId: requireActor(context.actor).id, role: invite.role })
          .onConflictDoUpdate({
            target: [canvasMembers.canvasId, canvasMembers.userId],
            set: { role: sql`case when ${canvasMembers.role} = 'editor' then 'editor' else ${invite.role} end` },
          });
      await tx
        .update(invitations)
        .set({ remainingUses: invite.remainingUses - 1 })
        .where(eq(invitations.id, invite.id));
      return { workspaceId: invite.workspaceId, canvasId: invite.canvasId };
    });
    if (!result) return notFound(context, "Invitation is unavailable or expired");
    return result;
  });
}
