import { eq } from "drizzle-orm";
import { entityIdParamsSchema, updateEntitySchema } from "@wooble/contracts";
import { db, entities } from "@wooble/db";
import type { EntityMetadata } from "@wooble/domain";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";
import { lockCanvasesForEntity, recordCanvasEvent } from "../canvas/activity";
import { describeUpdate } from "../canvas/undo";

export function entityRoutes(app: Api) {
  app.get("/api/entities/:entityId", async (context) => {
    const params = entityIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Entity ID must be a UUID");
    const [entity] = await db.select().from(entities).where(eq(entities.id, params.data.entityId)).limit(1);
    if (!entity) return notFound(context, "Entity not found");
    return { ...entity, createdAt: entity.createdAt.toISOString(), updatedAt: entity.updatedAt.toISOString() };
  });
  app.patch("/api/entities/:entityId", async (context) => {
    const params = entityIdParamsSchema.safeParse(context.params);
    const body = updateEntitySchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Entity ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid entity");
    const result = await db.transaction(async (tx) => {
      // Same lock order as undo: the canvases showing the entity, then the entity.
      const canvasIds = await lockCanvasesForEntity(tx, params.data.entityId);
      const [current] = await tx
        .select()
        .from(entities)
        .where(eq(entities.id, params.data.entityId))
        .for("update")
        .limit(1);
      if (!current) return { kind: "not-found" as const };
      if (body.data.type && (current.type === "system") !== (body.data.type === "system"))
        return { kind: "invalid" as const };
      const metadata: Record<string, unknown> = { ...current.metadata };
      for (const [key, value] of Object.entries(body.data.metadata ?? {})) {
        if (value === null || value === "") delete metadata[key];
        else metadata[key] = value;
      }
      const [updated] = await tx
        .update(entities)
        .set({
          type: body.data.type ?? current.type,
          name: body.data.name ?? current.name,
          description: body.data.description === undefined ? current.description : body.data.description,
          metadata: metadata as EntityMetadata,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, params.data.entityId))
        .returning();
      // The history row commits or rolls back with the change it describes. It
      // holds previous values for the changed fields and keys only; a save that
      // changed nothing leaves no history.
      const change = describeUpdate("entity", current, updated);
      for (const canvasId of change ? canvasIds : []) {
        await recordCanvasEvent(tx, {
          canvasId,
          actor: context.actor,
          action: "entity.updated",
          targetType: "entity",
          targetId: updated.id,
          targetName: updated.name || "New node",
          metadata: { ...change },
        });
      }
      return { kind: "updated" as const, entity: updated };
    });
    if (result.kind === "not-found") return notFound(context, "Entity not found");
    if (result.kind === "invalid")
      return badRequest(context, "System boxes cannot be converted to or from another node type");
    const updated = result.entity;
    return { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() };
  });
}
