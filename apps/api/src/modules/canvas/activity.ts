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

/**
 * Metadata keys the activity read may expose. Stored metadata also carries undo payloads
 * (`previous`, `snapshot`, `previousMetadata`, ...) that hold historical content, so the read
 * is an allowlist: a key that is not listed here is never returned. Each key is a short
 * descriptor: the changed field names, an entity or connection type, or a count or undo reference.
 */
export const ACTIVITY_METADATA_ALLOWLIST = [
  "fields",
  "type",
  "nodes",
  "connections",
  "removedNodes",
  "removedConnections",
  "undoOf",
  "undoneAction",
  "skipped",
] as const;

type ActivityMetadataValue = string | number | boolean | null | string[];

function isDisplayValue(value: unknown): value is ActivityMetadataValue {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Keeps only allowlisted keys whose value is a plain scalar (or a list of names), never an object. */
export function redactActivityMetadata(metadata: unknown): Record<string, ActivityMetadataValue> {
  const redacted: Record<string, ActivityMetadataValue> = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return redacted;
  const stored = metadata as Record<string, unknown>;
  for (const key of ACTIVITY_METADATA_ALLOWLIST) {
    if (Object.hasOwn(stored, key) && isDisplayValue(stored[key])) redacted[key] = stored[key];
  }
  return redacted;
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
    metadata: redactActivityMetadata(row.metadata),
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
