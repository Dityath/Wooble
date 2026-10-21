import { eq } from "drizzle-orm";
import { connectionIdParamsSchema, updateConnectionSchema } from "@wooble/contracts";
import { db, connections, entities } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";
import { canvasIdsForConnection, recordCanvasEvent, withCanvasLocks } from "../canvas/activity";
import { previousMetadataEntries, type UpdateEventMetadataV2 } from "../canvas/event-metadata";
import { DOCUMENTATION_KEY, DOCUMENTATION_UNDO_KEY, writeDocumentation } from "../collab/documentation";

export function connectionRoutes(app: Api) {
  app.get("/api/connections/:connectionId", async (context) => {
    const params = connectionIdParamsSchema.safeParse(context.params);
    if (!params.success) return badRequest(context, "Connection ID must be a UUID");
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, params.data.connectionId))
      .limit(1);
    if (!connection) return notFound(context, "Connection not found");
    const [source] = await db
      .select({ name: entities.name })
      .from(entities)
      .where(eq(entities.id, connection.sourceEntityId))
      .limit(1);
    const [target] = await db
      .select({ name: entities.name })
      .from(entities)
      .where(eq(entities.id, connection.targetEntityId))
      .limit(1);
    return {
      ...connection,
      sourceName: source?.name ?? "Unknown entity",
      targetName: target?.name ?? "Unknown entity",
    };
  });
  app.patch("/api/connections/:connectionId", async (context) => {
    const params = connectionIdParamsSchema.safeParse(context.params);
    const body = updateConnectionSchema.safeParse(context.body);
    if (!params.success) return badRequest(context, "Connection ID must be a UUID");
    if (!body.success) return badRequest(context, body.error.issues[0]?.message ?? "Invalid connection");
    const result = await withCanvasLocks(
      (tx) => canvasIdsForConnection(tx, params.data.connectionId),
      async (tx, currentCanvasIds) => {
        // Canvas rows are already locked (ascending id); now the connection row.
        const [current] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, params.data.connectionId))
          .for("update")
          .limit(1);
        if (!current) return null;
        const canvasIds = await currentCanvasIds();
        const metadata = { ...current.metadata };
        for (const [key, value] of Object.entries(body.data.metadata ?? {})) {
          if (key === DOCUMENTATION_KEY) continue;
          if (value === null || value === "") delete metadata[key as keyof typeof metadata];
          else Object.assign(metadata, { [key]: value });
        }
        let [updated] = await tx
          .update(connections)
          .set({
            type: body.data.type ?? current.type,
            label: body.data.label ?? current.label,
            description: body.data.description === undefined ? current.description : body.data.description,
            metadata,
          })
          .where(eq(connections.id, params.data.connectionId))
          .returning();
        const documentationUndo = Object.hasOwn(body.data.metadata ?? {}, DOCUMENTATION_KEY)
          ? (
              await writeDocumentation(
                tx,
                { kind: "connection", id: current.id },
                body.data.metadata?.documentation ?? null,
              )
            ).previous
          : undefined;
        if (documentationUndo) {
          [updated] = await tx.select().from(connections).where(eq(connections.id, current.id));
        }
        const previous: Record<string, unknown> = {};
        if (body.data.type !== undefined) previous.type = current.type;
        if (body.data.label !== undefined) previous.label = current.label;
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
            action: "connection.updated",
            targetType: "connection",
            targetId: updated.id,
            targetName: updated.label || "Connection",
            metadata: { ...eventMetadata },
          });
        }
        return updated;
      },
    );
    if (!result) return notFound(context, "Connection not found");
    return result;
  });
}
