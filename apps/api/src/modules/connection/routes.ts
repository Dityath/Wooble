import { eq } from "drizzle-orm";
import { connectionIdParamsSchema, updateConnectionSchema } from "@wooble/contracts";
import { db, connections, entities } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";
import { lockCanvasesForConnection, recordCanvasEvent } from "../canvas/activity";

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
    const updated = await db.transaction(async (tx) => {
      // Same lock order as undo: the canvases showing the connection, then the connection.
      const canvasIds = await lockCanvasesForConnection(tx, params.data.connectionId);
      const [current] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, params.data.connectionId))
        .for("update")
        .limit(1);
      if (!current) return null;
      const metadata = { ...current.metadata };
      for (const [key, value] of Object.entries(body.data.metadata ?? {})) {
        if (value === null || value === "") delete metadata[key as keyof typeof metadata];
        else Object.assign(metadata, { [key]: value });
      }
      const [result] = await tx
        .update(connections)
        .set({
          type: body.data.type ?? current.type,
          label: body.data.label ?? current.label,
          description: body.data.description === undefined ? current.description : body.data.description,
          metadata,
        })
        .where(eq(connections.id, params.data.connectionId))
        .returning();
      // The history row commits or rolls back with the change it describes.
      for (const canvasId of canvasIds) {
        await recordCanvasEvent(tx, {
          canvasId,
          actor: context.actor,
          action: "connection.updated",
          targetType: "connection",
          targetId: result.id,
          targetName: result.label || "Connection",
          metadata: {
            fields: Object.keys(body.data),
            previous: {
              type: current.type,
              label: current.label,
              description: current.description,
              metadata: current.metadata,
            },
          },
        });
      }
      return result;
    });
    if (!updated) return notFound(context, "Connection not found");
    return updated;
  });
}
