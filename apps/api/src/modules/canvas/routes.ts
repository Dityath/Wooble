import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  createCanvasSchema,
  canvasIdParamsSchema,
  canvasActivityQuerySchema,
  createCanvasEntitySchema,
  createCanvasConnectionSchema,
  updateCanvasConnectionBendSchema,
  autoNeatCanvasSchema,
  updatePlacementsSchema,
} from "@wooble/contracts";
import {
  db,
  canvases,
  canvasConnections,
  canvasNodes,
  connections,
  entities,
  workspaces,
  canvasMembers,
  workspaceMembers,
  users,
  invitations,
} from "@wooble/db";
import { canvasSubtreeIds } from "@wooble/domain";
import { badRequest, notFound } from "../../lib/http-error";
import { requireActor, canvasRole, hashToken, newToken, materializeLinkViewer, type Api } from "../../lib/auth";
import { listCanvasEvents, recordCanvasEvent } from "./activity";
import { applyNextUndo } from "./undo";

const placementColumns = {
  entityId: canvasNodes.entityId,
  parentEntityId: canvasNodes.parentEntityId,
  x: canvasNodes.x,
  y: canvasNodes.y,
  width: canvasNodes.width,
  height: canvasNodes.height,
};

export function canvasRoutes(app: Api) {
  app.get("/api/canvases", async (context) => {
    const actor = requireActor(context.actor);
    const managed =
      actor.systemRole === "admin"
        ? []
        : await db
            .select({ id: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.userId, actor.id), eq(workspaceMembers.role, "manager")));
    const shared =
      actor.systemRole === "admin"
        ? []
        : await db.select({ id: canvasMembers.canvasId }).from(canvasMembers).where(eq(canvasMembers.userId, actor.id));
    if (actor.systemRole !== "admin" && !managed.length && !shared.length) return [];
    return db
      .select({
        id: canvases.id,
        workspaceId: canvases.workspaceId,
        name: canvases.name,
        description: canvases.description,
        shareMode: canvases.shareMode,
        updatedAt: canvases.updatedAt,
        systemCount: sql<number>`count(${entities.id}) filter (where ${entities.type} = 'system')::int`,
        serviceCount: sql<number>`count(${entities.id}) filter (where ${entities.type} = 'service')::int`,
      })
      .from(canvases)
      .where(
        actor.systemRole === "admin"
          ? undefined
          : or(
              managed.length
                ? inArray(
                    canvases.workspaceId,
                    managed.map((row) => row.id),
                  )
                : undefined,
              shared.length
                ? inArray(
                    canvases.id,
                    shared.map((row) => row.id),
                  )
                : undefined,
            ),
      )
      .leftJoin(canvasNodes, eq(canvasNodes.canvasId, canvases.id))
      .leftJoin(entities, eq(canvasNodes.entityId, entities.id))
      .groupBy(canvases.id)
      .orderBy(canvases.name)
      .then((rows) => rows.map((canvas) => ({ ...canvas, updatedAt: canvas.updatedAt.toISOString() })));
  });

  app.post("/api/canvases", async (context) => {
    const parsed = createCanvasSchema.safeParse(context.body);
    if (!parsed.success) return badRequest(context, parsed.error.issues[0]?.message ?? "Invalid canvas");
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, parsed.data.workspaceId))
      .limit(1);
    if (!workspace) return notFound(context, "Workspace not found");
    const role =
      requireActor(context.actor).systemRole === "admin"
        ? "manager"
        : (
            await db
              .select({ role: workspaceMembers.role })
              .from(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, workspace.id),
                  eq(workspaceMembers.userId, requireActor(context.actor).id),
                ),
              )
              .limit(1)
          )[0]?.role;
    if (role !== "manager") {
      context.set.status = 403;
      return { message: "Only workspace managers can create canvases" };
    }
    const [canvas] = await db.insert(canvases).values(parsed.data).returning();
    context.set.status = 201;
    return { ...canvas, updatedAt: canvas.updatedAt.toISOString(), systemCount: 0, serviceCount: 0 };
  });

  app.get("/api/canvases/:canvasId", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    const [canvas] = await db.select().from(canvases).where(eq(canvases.id, params.data.canvasId)).limit(1);
    if (!canvas) return notFound(context, "Canvas not found");
    return { ...canvas, updatedAt: canvas.updatedAt.toISOString() };
  });

  app.get("/api/canvases/:canvasId/access", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    const role = context.actor ? await canvasRole(context.actor, params.data.canvasId) : "viewer";
    if (context.actor && role === "viewer") await materializeLinkViewer(context.actor, params.data.canvasId);
    return { role };
  });
  app.patch("/api/canvases/:canvasId", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(500).optional(),
        shareMode: z.enum(["restricted", "link"]).optional(),
      })
      .safeParse(context.body);
    if (!params.success || !body.success || !Object.keys(body.data).length)
      return badRequest(context, "Invalid canvas");
    const [previous] = await db
      .select({
        name: canvases.name,
        description: canvases.description,
        shareMode: canvases.shareMode,
      })
      .from(canvases)
      .where(eq(canvases.id, params.data.canvasId))
      .limit(1);
    const [row] = await db
      .update(canvases)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(canvases.id, params.data.canvasId))
      .returning();
    if (!row) return notFound(context, "Canvas not found");
    await recordCanvasEvent(db, {
      canvasId: row.id,
      actor: context.actor,
      action: "canvas.updated",
      targetType: "canvas",
      targetId: row.id,
      targetName: row.name,
      metadata: { fields: Object.keys(body.data), previous },
    });
    return { ...row, updatedAt: row.updatedAt.toISOString() };
  });
  app.delete("/api/canvases/:canvasId", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    const [row] = await db.delete(canvases).where(eq(canvases.id, params.data.canvasId)).returning({ id: canvases.id });
    if (!row) return notFound(context, "Canvas not found");
    return { ok: true };
  });
  app.get("/api/canvases/:canvasId/members", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    return db
      .select({ id: users.id, name: users.name, email: users.email, role: canvasMembers.role })
      .from(canvasMembers)
      .innerJoin(users, eq(users.id, canvasMembers.userId))
      .where(eq(canvasMembers.canvasId, params.data.canvasId))
      .orderBy(users.name);
  });
  app.post("/api/canvases/:canvasId/members", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .transform((value) => value.toLowerCase()),
        role: z.enum(["editor", "viewer"]),
      })
      .safeParse(context.body);
    if (!params.success || !body.success) return badRequest(context, "Invalid canvas member");
    const [canvas] = await db
      .select({ workspaceId: canvases.workspaceId })
      .from(canvases)
      .where(eq(canvases.id, params.data.canvasId))
      .limit(1);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.data.email)).limit(1);
    if (!canvas || !user) return notFound(context, "Canvas or registered user not found");
    await db.transaction(async (tx) => {
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: canvas.workspaceId, userId: user.id, role: "member" })
        .onConflictDoNothing();
      await tx
        .insert(canvasMembers)
        .values({ canvasId: params.data.canvasId, userId: user.id, role: body.data.role })
        .onConflictDoUpdate({ target: [canvasMembers.canvasId, canvasMembers.userId], set: { role: body.data.role } });
    });
    context.set.status = 201;
    return { id: user.id, role: body.data.role };
  });
  app.patch("/api/canvases/:canvasId/members/:userId", async (context) => {
    const params = canvasIdParamsSchema.extend({ userId: z.string().uuid() }).safeParse(context.params);
    const body = z.object({ role: z.enum(["editor", "viewer"]) }).safeParse(context.body);
    if (!params.success || !body.success) return badRequest(context, "Invalid canvas member");
    const [row] = await db
      .update(canvasMembers)
      .set({ role: body.data.role })
      .where(and(eq(canvasMembers.canvasId, params.data.canvasId), eq(canvasMembers.userId, params.data.userId)))
      .returning();
    if (!row) return notFound(context, "Canvas member not found");
    return { id: row.userId, role: row.role };
  });
  app.delete("/api/canvases/:canvasId/members/:userId", async (context) => {
    const params = canvasIdParamsSchema.extend({ userId: z.string().uuid() }).safeParse(context.params);
    if (!params.success) return badRequest(context, "Invalid canvas member");
    await db
      .delete(canvasMembers)
      .where(and(eq(canvasMembers.canvasId, params.data.canvasId), eq(canvasMembers.userId, params.data.userId)));
    return { ok: true };
  });
  app.post("/api/canvases/:canvasId/invitations", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = z.object({ role: z.enum(["editor", "viewer"]) }).safeParse(context.body);
    if (!params.success || !body.success) return badRequest(context, "Invalid invitation");
    const [canvas] = await db
      .select({ workspaceId: canvases.workspaceId })
      .from(canvases)
      .where(eq(canvases.id, params.data.canvasId))
      .limit(1);
    if (!canvas) return notFound(context, "Canvas not found");
    const token = newToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    await db.insert(invitations).values({
      tokenHash: hashToken(token),
      workspaceId: canvas.workspaceId,
      canvasId: params.data.canvasId,
      role: body.data.role,
      createdBy: requireActor(context.actor).id,
      expiresAt,
    });
    context.set.status = 201;
    return { token, role: body.data.role, expiresAt: expiresAt.toISOString() };
  });

  app.get("/api/canvases/:canvasId/graph", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    const [canvas] = await db.select().from(canvases).where(eq(canvases.id, params.data.canvasId)).limit(1);
    if (!canvas) return notFound(context, "Canvas not found");
    const [placementRows, linkRows] = await Promise.all([
      db.select().from(canvasNodes).where(eq(canvasNodes.canvasId, canvas.id)),
      db
        .select({ connectionId: canvasConnections.connectionId, bend: canvasConnections.bend })
        .from(canvasConnections)
        .where(eq(canvasConnections.canvasId, canvas.id)),
    ]);
    const entityIds = [...new Set(placementRows.map((row) => row.entityId))];
    const connectionIds = linkRows.map((row) => row.connectionId);
    const bends = new Map(linkRows.map((row) => [row.connectionId, row.bend]));
    const [entityRows, connectionRows] = await Promise.all([
      entityIds.length ? db.select().from(entities).where(inArray(entities.id, entityIds)) : Promise.resolve([]),
      connectionIds.length
        ? db.select().from(connections).where(inArray(connections.id, connectionIds))
        : Promise.resolve([]),
    ]);
    return {
      canvas: {
        id: canvas.id,
        workspaceId: canvas.workspaceId,
        name: canvas.name,
        description: canvas.description,
        shareMode: canvas.shareMode,
        updatedAt: canvas.updatedAt.toISOString(),
      },
      entities: entityRows.map((entity) => ({
        ...entity,
        createdAt: entity.createdAt.toISOString(),
        updatedAt: entity.updatedAt.toISOString(),
      })),
      placements: placementRows,
      connections: connectionRows.map((connection) => ({
        ...connection,
        bend: bends.get(connection.id) ?? null,
      })),
    };
  });

  app.get("/api/canvases/:canvasId/activity", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const query = canvasActivityQuerySchema.safeParse(context.query);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    if (!query.success) return badRequest(context, "Invalid activity query");
    const [canvas] = await db
      .select({ id: canvases.id })
      .from(canvases)
      .where(eq(canvases.id, params.data.canvasId))
      .limit(1);
    if (!canvas) return notFound(context, "Canvas not found");
    return { events: await listCanvasEvents(canvas.id, query.data.limit) };
  });

  app.post("/api/canvases/:canvasId/entities", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = createCanvasEntitySchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid entity");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select()
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const { type, name, x, y, parentEntityId } = body.data;
      if (parentEntityId) {
        const [parent] = await tx
          .select({ entityId: canvasNodes.entityId })
          .from(canvasNodes)
          .where(sql`${canvasNodes.canvasId} = ${canvas.id} and ${canvasNodes.entityId} = ${parentEntityId}`)
          .limit(1);
        if (!parent) return { kind: "invalid" as const, message: "Parent must be on this canvas" };
      }
      const [entity] = await tx.insert(entities).values({ workspaceId: canvas.workspaceId, type, name }).returning();
      await tx.insert(canvasNodes).values({
        canvasId: canvas.id,
        entityId: entity.id,
        parentEntityId,
        x,
        y,
        width: type === "system" ? (parentEntityId ? 300 : 440) : 220,
        height: type === "system" ? (parentEntityId ? 220 : 360) : 120,
      });
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "entity.created",
        targetType: "entity",
        targetId: entity.id,
        targetName: entity.name || "New node",
        metadata: { type },
      });
      return { kind: "created" as const, id: entity.id };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas not found");
    if (result.kind === "invalid") return badRequest(context, result.message);
    context.set.status = 201;
    return result;
  });

  app.post("/api/canvases/:canvasId/connections", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = createCanvasConnectionSchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid connection");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select()
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const placed = await tx
        .select({ entityId: canvasNodes.entityId, name: entities.name })
        .from(canvasNodes)
        .innerJoin(entities, eq(canvasNodes.entityId, entities.id))
        .where(
          sql`${canvasNodes.canvasId} = ${canvas.id} and ${canvasNodes.entityId} in (${body.data.sourceEntityId}, ${body.data.targetEntityId})`,
        );
      if (new Set(placed.map((item) => item.entityId)).size !== 2)
        return { kind: "invalid" as const, message: "Both nodes must be on this canvas" };
      const [connection] = await tx
        .insert(connections)
        .values({ workspaceId: canvas.workspaceId, ...body.data, label: "" })
        .returning();
      await tx.insert(canvasConnections).values({ canvasId: canvas.id, connectionId: connection.id });
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "connection.created",
        targetType: "connection",
        targetId: connection.id,
        targetName: connectionTitle(placed, body.data),
        metadata: { type: body.data.type },
      });
      return { kind: "created" as const, id: connection.id };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas not found");
    if (result.kind === "invalid") return badRequest(context, result.message);
    context.set.status = 201;
    return result;
  });

  app.put("/api/canvases/:canvasId/connections/:connectionId/bend", async (context) => {
    const params = canvasIdParamsSchema.extend({ connectionId: z.string().uuid() }).safeParse(context.params);
    const body = updateCanvasConnectionBendSchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Canvas and connection IDs must be UUIDs");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid connector bend");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const [existing] = await tx
        .select({ bend: canvasConnections.bend })
        .from(canvasConnections)
        .where(
          sql`${canvasConnections.canvasId} = ${canvas.id} and ${canvasConnections.connectionId} = ${params.data.connectionId}`,
        )
        .limit(1);
      const [link] = await tx
        .update(canvasConnections)
        .set({ bend: body.data.bend })
        .where(
          sql`${canvasConnections.canvasId} = ${canvas.id} and ${canvasConnections.connectionId} = ${params.data.connectionId}`,
        )
        .returning({ connectionId: canvasConnections.connectionId });
      if (!link) return { kind: "not-found" as const };
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "connection.updated",
        targetType: "connection",
        targetId: params.data.connectionId,
        metadata: { field: "bend", previousBend: existing?.bend ?? null },
      });
      return { kind: "saved" as const };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas connection not found");
    return { bend: body.data.bend };
  });

  app.put("/api/canvases/:canvasId/auto-neat", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = autoNeatCanvasSchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid layout");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id, updatedAt: canvases.updatedAt })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      if (canvas.updatedAt.toISOString() !== body.data.expectedUpdatedAt) return { kind: "conflict" as const };

      const [currentNodes, currentLinks] = await Promise.all([
        tx.select(placementColumns).from(canvasNodes).where(eq(canvasNodes.canvasId, canvas.id)),
        tx
          .select({ connectionId: canvasConnections.connectionId, bend: canvasConnections.bend })
          .from(canvasConnections)
          .where(eq(canvasConnections.canvasId, canvas.id)),
      ]);
      const currentParents = new Map(currentNodes.map((node) => [node.entityId, node.parentEntityId]));
      if (
        currentNodes.length !== body.data.placements.length ||
        body.data.placements.some(
          (node) => !currentParents.has(node.entityId) || currentParents.get(node.entityId) !== node.parentEntityId,
        )
      )
        return { kind: "conflict" as const };
      const currentConnectionIds = new Set(currentLinks.map((link) => link.connectionId));
      if (
        currentLinks.length !== body.data.connections.length ||
        body.data.connections.some((link) => !currentConnectionIds.has(link.connectionId))
      )
        return { kind: "conflict" as const };

      if (body.data.placements.length)
        await tx
          .insert(canvasNodes)
          .values(body.data.placements.map((node) => ({ canvasId: canvas.id, ...node })))
          .onConflictDoUpdate({
            target: [canvasNodes.canvasId, canvasNodes.entityId],
            set: {
              x: sql`excluded.x`,
              y: sql`excluded.y`,
              width: sql`excluded.width`,
              height: sql`excluded.height`,
            },
          });
      for (const link of body.data.connections) {
        await tx
          .update(canvasConnections)
          .set({ bend: link.bend })
          .where(
            sql`${canvasConnections.canvasId} = ${canvas.id} and ${canvasConnections.connectionId} = ${link.connectionId}`,
          );
      }
      const [updated] = await tx
        .update(canvases)
        .set({ updatedAt: new Date() })
        .where(eq(canvases.id, canvas.id))
        .returning({ updatedAt: canvases.updatedAt });
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "canvas.auto_neat",
        targetType: "canvas",
        targetId: canvas.id,
        metadata: {
          nodes: body.data.placements.length,
          connections: body.data.connections.length,
          previous: { placements: currentNodes, connections: currentLinks },
        },
      });
      return { kind: "saved" as const, updatedAt: updated.updatedAt.toISOString() };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas not found");
    if (result.kind === "conflict") {
      context.set.status = 409;
      return { error: "layout_conflict", message: "Canvas changed. Retry Auto Neat." };
    }
    return result;
  });

  app.delete("/api/canvases/:canvasId/connections/:connectionId", async (context) => {
    const params = canvasIdParamsSchema.extend({ connectionId: z.string().uuid() }).safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas and connection IDs must be UUIDs");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const [existing] = await tx
        .select({
          connection: connections,
          bend: canvasConnections.bend,
        })
        .from(canvasConnections)
        .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
        .where(
          and(eq(canvasConnections.canvasId, canvas.id), eq(canvasConnections.connectionId, params.data.connectionId)),
        )
        .limit(1);
      const [removed] = await tx
        .delete(canvasConnections)
        .where(
          and(eq(canvasConnections.canvasId, canvas.id), eq(canvasConnections.connectionId, params.data.connectionId)),
        )
        .returning({ connectionId: canvasConnections.connectionId });
      if (!removed) return { kind: "not-found" as const };
      const [stillUsed] = await tx
        .select({ id: canvasConnections.connectionId })
        .from(canvasConnections)
        .where(eq(canvasConnections.connectionId, removed.connectionId))
        .limit(1);
      if (!stillUsed) await tx.delete(connections).where(eq(connections.id, removed.connectionId));
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "connection.deleted",
        targetType: "connection",
        targetId: params.data.connectionId,
        targetName: existing?.connection.label || "Connection",
        metadata: {
          type: existing?.connection.type,
          connection: existing
            ? (() => {
                const { createdAt: _createdAt, ...connection } = existing.connection;
                return { ...connection, bend: existing.bend };
              })()
            : null,
        },
      });
      return { kind: "deleted" as const };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas connection not found");
    return result;
  });

  app.delete("/api/canvases/:canvasId/entities/:entityId", async (context) => {
    const params = canvasIdParamsSchema.extend({ entityId: z.string().uuid() }).safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas and entity IDs must be UUIDs");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const placements = await tx
        .select({ entityId: canvasNodes.entityId, parentEntityId: canvasNodes.parentEntityId })
        .from(canvasNodes)
        .where(eq(canvasNodes.canvasId, canvas.id));
      if (!placements.some((item) => item.entityId === params.data.entityId)) return { kind: "not-found" as const };
      const [targetEntity] = await tx
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.id, params.data.entityId))
        .limit(1);
      const entityIds = canvasSubtreeIds(placements, params.data.entityId);
      const affectedLinks = await tx
        .select({ id: connections.id })
        .from(canvasConnections)
        .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
        .where(
          and(
            eq(canvasConnections.canvasId, canvas.id),
            or(inArray(connections.sourceEntityId, entityIds), inArray(connections.targetEntityId, entityIds)),
          ),
        );
      const linkIds = affectedLinks.map((item) => item.id);
      const [subtreeEntities, subtreePlacements, linkRows] = await Promise.all([
        tx
          .select({
            id: entities.id,
            workspaceId: entities.workspaceId,
            type: entities.type,
            name: entities.name,
            description: entities.description,
            metadata: entities.metadata,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds)),
        tx
          .select(placementColumns)
          .from(canvasNodes)
          .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(canvasNodes.entityId, entityIds))),
        linkIds.length
          ? tx
              .select({ connection: connections, bend: canvasConnections.bend })
              .from(canvasConnections)
              .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
              .where(and(eq(canvasConnections.canvasId, canvas.id), inArray(canvasConnections.connectionId, linkIds)))
          : Promise.resolve(
              [] as Array<{
                connection: typeof connections.$inferSelect;
                bend: typeof canvasConnections.$inferInsert.bend;
              }>,
            ),
      ]);
      const snapshot = {
        entities: subtreeEntities,
        placements: subtreePlacements,
        connections: linkRows.map(({ connection, bend }) => {
          const { createdAt: _createdAt, ...rest } = connection;
          return { ...rest, bend };
        }),
      };
      if (linkIds.length)
        await tx
          .delete(canvasConnections)
          .where(and(eq(canvasConnections.canvasId, canvas.id), inArray(canvasConnections.connectionId, linkIds)));
      await tx
        .delete(canvasNodes)
        .where(and(eq(canvasNodes.canvasId, canvas.id), inArray(canvasNodes.entityId, entityIds)));
      for (const id of linkIds) {
        const [stillUsed] = await tx
          .select({ id: canvasConnections.connectionId })
          .from(canvasConnections)
          .where(eq(canvasConnections.connectionId, id))
          .limit(1);
        if (!stillUsed) await tx.delete(connections).where(eq(connections.id, id));
      }
      for (const id of entityIds) {
        const [stillPlaced] = await tx
          .select({ id: canvasNodes.entityId })
          .from(canvasNodes)
          .where(eq(canvasNodes.entityId, id))
          .limit(1);
        if (!stillPlaced) await tx.delete(entities).where(eq(entities.id, id));
      }
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor: context.actor,
        action: "entity.deleted",
        targetType: "entity",
        targetId: params.data.entityId,
        targetName: targetEntity?.name || "New node",
        metadata: {
          removedNodes: entityIds.length,
          removedConnections: linkIds.length,
          snapshot,
        },
      });
      return { kind: "deleted" as const, removedNodes: entityIds.length, removedConnections: linkIds.length };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas node not found");
    return result;
  });

  app.put("/api/canvases/:canvasId/placements", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    const body = updatePlacementsSchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid placements");
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id, workspaceId: canvases.workspaceId })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      if (body.data.placements.length === 0) return { kind: "saved" as const, saved: 0 };

      const existingRows = await tx
        .select(placementColumns)
        .from(canvasNodes)
        .where(eq(canvasNodes.canvasId, canvas.id));
      const placementEntityIds = new Set(body.data.placements.map((placement) => placement.entityId));
      const referencedEntityIds = new Set(placementEntityIds);
      body.data.placements.forEach((placement) => {
        if (placement.parentEntityId) referencedEntityIds.add(placement.parentEntityId);
      });
      const referencedEntities = await tx
        .select({ id: entities.id, workspaceId: entities.workspaceId, name: entities.name })
        .from(entities)
        .where(inArray(entities.id, [...referencedEntityIds]));
      const entitiesById = new Map(referencedEntities.map((entity) => [entity.id, entity]));
      if ([...referencedEntityIds].some((entityId) => entitiesById.get(entityId)?.workspaceId !== canvas.workspaceId)) {
        return {
          kind: "invalid" as const,
          message: "Placement entities and parents must belong to the canvas workspace",
        };
      }

      const parentByEntityId = new Map(existingRows.map((placement) => [placement.entityId, placement.parentEntityId]));
      for (const placement of body.data.placements) {
        parentByEntityId.set(placement.entityId, placement.parentEntityId);
      }
      for (const placement of body.data.placements) {
        if (placement.parentEntityId && !parentByEntityId.has(placement.parentEntityId)) {
          return { kind: "invalid" as const, message: "Parent entity must have a placement on the same canvas" };
        }
      }
      if (hasParentCycle(parentByEntityId)) {
        return { kind: "invalid" as const, message: "Parent relationships cannot contain a cycle" };
      }

      const existingByEntityId = new Map(existingRows.map((placement) => [placement.entityId, placement]));
      const changedPlacements = body.data.placements.filter((placement) => {
        const existing = existingByEntityId.get(placement.entityId);
        return (
          !existing ||
          existing.parentEntityId !== placement.parentEntityId ||
          existing.x !== placement.x ||
          existing.y !== placement.y ||
          existing.width !== placement.width ||
          existing.height !== placement.height
        );
      });
      await tx
        .insert(canvasNodes)
        .values(body.data.placements.map((placement) => ({ canvasId: canvas.id, ...placement })))
        .onConflictDoUpdate({
          target: [canvasNodes.canvasId, canvasNodes.entityId],
          set: {
            parentEntityId: sql`excluded.parent_entity_id`,
            x: sql`excluded.x`,
            y: sql`excluded.y`,
            width: sql`excluded.width`,
            height: sql`excluded.height`,
          },
        });
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      if (changedPlacements.length) {
        await recordCanvasEvent(tx, {
          canvasId: canvas.id,
          actor: context.actor,
          action: "placement.updated",
          targetType: "canvas",
          targetId: canvas.id,
          targetName:
            changedPlacements.length === 1
              ? entitiesById.get(changedPlacements[0].entityId)?.name || "1 node"
              : `${changedPlacements.length} nodes`,
          metadata: {
            placements: changedPlacements.map((placement) => ({
              entityId: placement.entityId,
              parentEntityId: placement.parentEntityId,
              from: existingByEntityId.get(placement.entityId) ?? null,
              to: placement,
            })),
          },
        });
      }
      return { kind: "saved" as const, saved: body.data.placements.length };
    });

    if (result.kind === "not-found") return notFound(context, "Canvas not found");
    if (result.kind === "invalid") return badRequest(context, result.message);
    return { saved: result.saved };
  });

  app.post("/api/canvases/:canvasId/undo", async (context) => {
    const params = canvasIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Canvas ID must be a UUID");
    const actor = requireActor(context.actor);
    const result = await db.transaction(async (tx) => {
      const [canvas] = await tx
        .select({ id: canvases.id })
        .from(canvases)
        .where(eq(canvases.id, params.data.canvasId))
        .for("update")
        .limit(1);
      if (!canvas) return { kind: "not-found" as const };
      const outcome = await applyNextUndo(tx, canvas.id, actor.id);
      if (!outcome.undoneEvent && !outcome.skipped.length) return { kind: "nothing" as const };
      if (!outcome.undoneEvent) {
        // No-op-only walks are honestly reported as "nothing undone"; only
        // collaborator conflicts deserve the explicit refusal.
        if (!outcome.skipped.some((item) => item.reason === "conflict")) return { kind: "nothing" as const };
        return { kind: "conflict" as const, skipped: outcome.skipped };
      }
      await recordCanvasEvent(tx, {
        canvasId: canvas.id,
        actor,
        action: "canvas.undo",
        targetType: outcome.undoneEvent.targetType,
        targetId: outcome.undoneEvent.targetId,
        targetName: outcome.undoneEvent.targetName,
        metadata: {
          undoOf: outcome.undoneEvent.id,
          undoneAction: outcome.undoneEvent.action,
          skipped: outcome.skipped,
        },
      });
      await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvas.id));
      return { kind: "undone" as const, action: outcome.undoneEvent.action, skipped: outcome.skipped };
    });
    if (result.kind === "not-found") return notFound(context, "Canvas not found");
    if (result.kind === "nothing") return { undone: false };
    if (result.kind === "conflict") {
      context.set.status = 409;
      return {
        error: "undo_conflict",
        message:
          "Your recent changes can't be undone because collaborators changed the same objects since. Nothing was undone.",
        skipped: result.skipped,
      };
    }
    return { undone: true, action: result.action, skipped: result.skipped };
  });
}

function connectionTitle(
  placed: { entityId: string; name: string }[],
  data: { sourceEntityId: string; targetEntityId: string },
) {
  const nameById = new Map(placed.map((item) => [item.entityId, item.name]));
  const source = nameById.get(data.sourceEntityId);
  const target = nameById.get(data.targetEntityId);
  return `${source || "New node"} → ${target || "New node"}`;
}

function hasParentCycle(parentByEntityId: Map<string, string | null>): boolean {
  const visited = new Set<string>();
  for (const entityId of parentByEntityId.keys()) {
    const path = new Set<string>();
    let currentId: string | null | undefined = entityId;
    while (currentId && parentByEntityId.has(currentId)) {
      if (path.has(currentId)) return true;
      if (visited.has(currentId)) break;
      path.add(currentId);
      currentId = parentByEntityId.get(currentId);
    }
    for (const id of path) visited.add(id);
  }
  return false;
}
