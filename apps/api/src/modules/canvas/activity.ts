import { desc, eq } from "drizzle-orm";
import { canvasConnections, canvasEvents, canvasNodes, db, type CanvasEventAction } from "@wooble/db";
import type { Actor } from "../../lib/auth";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

export interface CanvasEventInput {
  canvasId: string;
  actor: Actor | null;
  action: CanvasEventAction;
  targetType: "entity" | "connection" | "canvas";
  targetId?: string | null;
  targetName?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordCanvasEvent(executor: Executor, input: CanvasEventInput): Promise<void> {
  await executor.insert(canvasEvents).values({
    canvasId: input.canvasId,
    actorUserId: input.actor?.id ?? null,
    actorName: input.actor?.name ?? "System",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetName: input.targetName ?? null,
    metadata: input.metadata ?? {},
  });
}

export async function listCanvasEvents(canvasId: string, limit: number) {
  // The feed keeps the full history: undone events stay visible and are flagged to the UI.
  const rows = await db
    .select()
    .from(canvasEvents)
    .where(eq(canvasEvents.canvasId, canvasId))
    .orderBy(desc(canvasEvents.createdAt), desc(canvasEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: row.targetName,
    metadata: row.metadata,
    undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function canvasIdsForEntity(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(eq(canvasNodes.entityId, entityId));
  return rows.map((row) => row.canvasId);
}

export async function canvasIdsForConnection(connectionId: string): Promise<string[]> {
  const rows = await db
    .select({ canvasId: canvasConnections.canvasId })
    .from(canvasConnections)
    .where(eq(canvasConnections.connectionId, connectionId));
  return rows.map((row) => row.canvasId);
}
