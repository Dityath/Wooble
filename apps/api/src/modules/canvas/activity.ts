import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { canvases, canvasConnections, canvasEvents, canvasNodes, db, type CanvasEventAction } from "@wooble/db";
import type { Actor } from "../../lib/auth";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Transaction;

export interface CanvasEventInput {
  canvasId: string;
  actor: Actor | null;
  action: CanvasEventAction;
  targetType: "entity" | "connection" | "canvas";
  targetId?: string | null;
  targetName?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records an event inside the caller's mutation transaction. Every writer holds
 * the canvas row lock when it gets here, so `clock_timestamp()` (not the
 * transaction-start `now()`) orders a canvas's events in commit order, which
 * is the order undo relies on.
 */
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
    createdAt: sql`clock_timestamp()`,
  });
}

/**
 * The metadata each action exposes through the activity feed. Everything else
 * stays server-side: previous values and delete snapshots hold old
 * documentation, contract bodies and schema text that the canvas no longer
 * shows, and any reader of the canvas, including a viewer or link guest, can
 * read the feed.
 */
const activityMetadataKeys: Partial<Record<CanvasEventAction, readonly string[]>> = {
  "entity.created": ["type"],
  "entity.updated": ["fields", "metadataKeys"],
  "entity.deleted": ["removedNodes", "removedConnections"],
  "connection.created": ["type"],
  "connection.updated": ["field", "fields", "metadataKeys"],
  "connection.deleted": ["type"],
  "canvas.updated": ["fields"],
  "canvas.auto_neat": ["nodes", "connections"],
  "canvas.undo": ["undoOf", "undoneAction", "skipped"],
};

function isSummaryValue(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function activityMetadata(action: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of activityMetadataKeys[action as CanvasEventAction] ?? []) {
    const value = metadata[key];
    if (key === "skipped" && Array.isArray(value)) {
      projected.skipped = value.map((item) => {
        const { action: skippedAction, targetName, reason } = (item ?? {}) as Record<string, unknown>;
        return { action: skippedAction, targetName, reason };
      });
    } else if (value !== undefined && isSummaryValue(value)) projected[key] = value;
  }
  return projected;
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
    metadata: activityMetadata(row.action, row.metadata ?? {}),
    undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function canvasIdsForEntity(executor: Executor, entityId: string): Promise<string[]> {
  const rows = await executor
    .select({ canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(eq(canvasNodes.entityId, entityId));
  return [...new Set(rows.map((row) => row.canvasId))];
}

export async function canvasIdsForConnection(executor: Executor, connectionId: string): Promise<string[]> {
  const rows = await executor
    .select({ canvasId: canvasConnections.canvasId })
    .from(canvasConnections)
    .where(eq(canvasConnections.connectionId, connectionId));
  return [...new Set(rows.map((row) => row.canvasId))];
}

/**
 * Locks the canvases that show a shared object, in id order, before the object
 * itself is locked. Undo takes the same order (canvas, then object), so the
 * two never deadlock and an undo always sees the event of a concurrent edit.
 * A placement added between the read and the lock is picked up by re-reading
 * until the set is stable; the returned ids are the canvases to record on.
 */
async function lockCanvasesShowing(tx: Transaction, readIds: () => Promise<string[]>): Promise<string[]> {
  const locked = new Set<string>();
  for (;;) {
    const current = await readIds();
    const pending = current.filter((id) => !locked.has(id));
    if (!pending.length) return current.sort();
    const rows = await tx
      .select({ id: canvases.id })
      .from(canvases)
      .where(inArray(canvases.id, pending))
      .orderBy(asc(canvases.id))
      .for("update");
    for (const row of rows) locked.add(row.id);
    // A canvas deleted before it could be locked takes its placements with it.
    if (rows.length !== pending.length) for (const id of pending) locked.add(id);
  }
}

export function lockCanvasesForEntity(tx: Transaction, entityId: string): Promise<string[]> {
  return lockCanvasesShowing(tx, () => canvasIdsForEntity(tx, entityId));
}

export function lockCanvasesForConnection(tx: Transaction, connectionId: string): Promise<string[]> {
  return lockCanvasesShowing(tx, () => canvasIdsForConnection(tx, connectionId));
}
