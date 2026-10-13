import { asc, desc, eq, inArray } from "drizzle-orm";
import { canvasConnections, canvasEvents, canvasNodes, canvases, db, type CanvasEventAction } from "@wooble/db";
import type { Actor } from "../../lib/auth";
import type { Transaction } from "./undo-registry";

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
 * Records an event inside the caller's transaction, so the change and its event commit or roll back together.
 * Events are ordered by `seq`, which is allocated at insert, so per-canvas commit order equals seq order only
 * while the writer holds the canvas row lock. Callers lock the canvas row first (lock order: canvas rows, then
 * entity/connection/placement rows); the `FOR UPDATE` here is a safety net that is a no-op when already held.
 */
export async function recordCanvasEvent(tx: Transaction, input: CanvasEventInput): Promise<void> {
  await tx.select({ id: canvases.id }).from(canvases).where(eq(canvases.id, input.canvasId)).for("update");
  await tx.insert(canvasEvents).values({
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
    .orderBy(desc(canvasEvents.seq))
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

/** Canvas ids that place the entity, ascending. A plain read: callers lock the rows afterwards. */
export async function canvasIdsForEntity(executor: Transaction, entityId: string): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ canvasId: canvasNodes.canvasId })
    .from(canvasNodes)
    .where(eq(canvasNodes.entityId, entityId))
    .orderBy(asc(canvasNodes.canvasId));
  return rows.map((row) => row.canvasId);
}

/** Canvas ids that place the connection, ascending. A plain read: callers lock the rows afterwards. */
export async function canvasIdsForConnection(executor: Transaction, connectionId: string): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ canvasId: canvasConnections.canvasId })
    .from(canvasConnections)
    .where(eq(canvasConnections.connectionId, connectionId))
    .orderBy(asc(canvasConnections.canvasId));
  return rows.map((row) => row.canvasId);
}

class CanvasSetChanged extends Error {}

/** Raised when the canvas set kept changing; the error handler maps `status` 503 to a retryable response. */
export class CanvasLockContention extends Error {
  readonly status = 503;
  constructor() {
    super("The canvas changed while saving; try again");
  }
}
const MAX_LOCK_ATTEMPTS = 5;

/**
 * Runs `work` in one transaction that follows the global lock order: every affected canvas row `FOR UPDATE` in
 * ascending id order first, then whatever entity/connection rows `work` locks. `work` receives
 * `currentCanvasIds()`, to call after it has locked its own row.
 *
 * The canvas set is read before it can be locked, so it may change in between. A placement added later needs the
 * new canvas's lock, and its foreign key then waits on the entity row, which `work` already holds, so such a
 * placement cannot commit before us. A placement committed before our entity lock is caught by
 * `currentCanvasIds()`: if it names a canvas we do not hold, the whole transaction is rolled back (never locking
 * a canvas after an entity row, which could deadlock) and retried with the fresh set.
 */
export async function withCanvasLocks<T>(
  findCanvasIds: (tx: Transaction) => Promise<string[]>,
  work: (tx: Transaction, currentCanvasIds: () => Promise<string[]>) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const wanted = await findCanvasIds(tx);
        const locked = wanted.length
          ? (
              await tx
                .select({ id: canvases.id })
                .from(canvases)
                .where(inArray(canvases.id, wanted))
                .orderBy(asc(canvases.id))
                .for("update")
            ).map((row) => row.id)
          : [];
        const heldSet = new Set(locked);
        return work(tx, async () => {
          const fresh = await findCanvasIds(tx);
          if (fresh.some((id) => !heldSet.has(id))) throw new CanvasSetChanged();
          return fresh;
        });
      });
    } catch (error) {
      if (!(error instanceof CanvasSetChanged)) throw error;
      if (attempt >= MAX_LOCK_ATTEMPTS) throw new CanvasLockContention();
    }
  }
}
