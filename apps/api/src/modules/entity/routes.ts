import { eq } from "drizzle-orm";
import { entityIdParamsSchema, updateEntitySchema } from "@wooble/contracts";
import { db, entities } from "@wooble/db";
import type { EntityMetadata } from "@wooble/domain";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";
import { canvasIdsForEntity, recordCanvasEvent, withCanvasLocks } from "../canvas/activity";
import { previousMetadataEntries, type UpdateEventMetadataV2 } from "../canvas/event-metadata";
import { DOCUMENTATION_KEY, DOCUMENTATION_UNDO_KEY, writeDocumentation } from "../collab/documentation";

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
    const result = await withCanvasLocks(
      (tx) => canvasIdsForEntity(tx, params.data.entityId),
      async (tx, currentCanvasIds) => {
        // Canvas rows are already locked (ascending id); now the entity row.
        const [current] = await tx
          .select()
          .from(entities)
          .where(eq(entities.id, params.data.entityId))
          .for("update")
          .limit(1);
        if (!current) return { kind: "not-found" as const };
        const canvasIds = await currentCanvasIds();
        if (body.data.type && (current.type === "system") !== (body.data.type === "system"))
          return { kind: "invalid" as const };
        const metadata: Record<string, unknown> = { ...current.metadata };
        for (const [key, value] of Object.entries(body.data.metadata ?? {})) {
          if (key === DOCUMENTATION_KEY) continue;
          if (value === null || value === "") delete metadata[key];
          else metadata[key] = value;
        }
        let [updated] = await tx
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
        const documentationUndo = Object.hasOwn(body.data.metadata ?? {}, DOCUMENTATION_KEY)
          ? (
              await writeDocumentation(
                tx,
                { kind: "entity", id: current.id },
                body.data.metadata?.documentation ?? null,
              )
            ).previous
          : undefined;
        if (documentationUndo) {
          [updated] = await tx.select().from(entities).where(eq(entities.id, current.id));
        }
        const previous: Record<string, unknown> = {};
        if (body.data.type !== undefined) previous.type = current.type;
        if (body.data.name !== undefined) previous.name = current.name;
        if (body.data.description !== undefined) previous.description = current.description;
        const eventMetadata: UpdateEventMetadataV2 = {
          version: 2,
          fields: Object.keys(body.data),
          previous,
          previousMetadata: previousMetadataEntries(
            current.metadata,
            Object.keys(body.data.metadata ?? {}).filter((key) => key !== DOCUMENTATION_KEY),
          ),
          ...(documentationUndo ? { [DOCUMENTATION_UNDO_KEY]: documentationUndo } : {}),
        };
        for (const canvasId of canvasIds) {
          await recordCanvasEvent(tx, {
            canvasId,
            actor: context.actor,
            action: "entity.updated",
            targetType: "entity",
            targetId: updated.id,
            targetName: updated.name || "New node",
            metadata: { ...eventMetadata },
          });
        }
        return { kind: "updated" as const, entity: updated };
      },
    );
    if (result.kind === "not-found") return notFound(context, "Entity not found");
    if (result.kind === "invalid")
      return badRequest(context, "System boxes cannot be converted to or from another node type");
    const updated = result.entity;
    return { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() };
  });
}
