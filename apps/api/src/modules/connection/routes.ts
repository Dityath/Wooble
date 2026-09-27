import { eq } from "drizzle-orm";
import { connectionIdParamsSchema, updateConnectionSchema } from "@wooble/contracts";
import { db, connections, entities } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";
import { canvasIdsForConnection, recordCanvasEvent } from "../canvas/activity";

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
    let previousConnection: typeof connections.$inferSelect | undefined;
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, params.data.connectionId))
        .for("update")
        .limit(1);
      if (!current) return null;
      previousConnection = current;
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
      return result;
    });
    if (!updated) return notFound(context, "Connection not found");
    for (const canvasId of await canvasIdsForConnection(updated.id)) {
      await recordCanvasEvent(db, {
        canvasId,
        actor: context.actor,
        action: "connection.updated",
        targetType: "connection",
        targetId: updated.id,
        targetName: updated.label || "Connection",
        metadata: {
          fields: Object.keys(body.data),
          previous: {
            type: previousConnection?.type ?? updated.type,
            label: previousConnection?.label ?? "",
            description: previousConnection?.description ?? null,
            metadata: previousConnection?.metadata ?? {},
          },
        },
      });
    }
    return updated;
  });
}
