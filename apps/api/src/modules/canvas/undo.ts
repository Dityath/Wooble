import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  canvases,
  canvasConnections,
  canvasEvents,
  canvasNodes,
  connections,
  entities,
  type CanvasEventAction,
} from "@wooble/db";
import type { ConnectionPath, ConnectionType, EntityMetadata, EntityType } from "@wooble/domain";
import { canvasRole, objectAccess, type Actor } from "../../lib/auth";
import { postgresErrorCode } from "../../lib/http-error";
import {
  DOCUMENTATION_KEY,
  DOCUMENTATION_SNAPSHOT_KEY,
  type DocumentRef,
  documentationUndoEntry,
  isBootstrapped,
  restoreDocumentation,
  withoutDocumentation,
} from "../collab/documentation";
import { CanvasLockContention } from "./activity";
import { isUpdateEventMetadataV2, type PreviousMetadataEntry } from "./event-metadata";
import { isExternalMetadataKey, listNonReversibleActions, restoreDeleteHooks, type Transaction } from "./undo-registry";

type CanvasEventRow = typeof canvasEvents.$inferSelect;

interface PlacementSnapshot {
  entityId: string;
  parentEntityId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ConnectionSnapshot {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: ConnectionType;
  label: string;
  description: string | null;
  metadata: Record<string, unknown>;
  bend: ConnectionPath;
}

interface EntitySnapshot {
  id: string;
  workspaceId: string;
  type: EntityType;
  name: string;
  description: string | null;
  metadata: EntityMetadata;
}

export async function markUndone(tx: Transaction, eventId: string) {
  await tx.update(canvasEvents).set({ undoneAt: new Date() }).where(eq(canvasEvents.id, eventId));
}

export type UndoSkipReason = "conflict" | "no-op";

export interface UndoSkippedEvent {
  action: CanvasEventAction;
  targetName: string | null;
  reason: UndoSkipReason;
}

const MAX_UNDO_ATTEMPTS = 3;

/**
 * Runs a whole undo transaction again when PostgreSQL aborts it as a deadlock victim (40P01) or serialization
 * failure (40001). Every attempt is a fresh transaction, so nothing of the aborted one survives. After
 * `MAX_UNDO_ATTEMPTS` the request fails with `CanvasLockContention` (503, retryable), the same answer the
 * entity/connection PATCH routes give when their canvas set keeps changing, never a 500.
 */
export async function retryOnLockConflict<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code !== "40P01" && code !== "40001") throw error;
      if (attempt >= MAX_UNDO_ATTEMPTS) throw new CanvasLockContention();
    }
  }
}

export interface UndoOutcome {
  /** The event that was actually reversed and marked undone, if any. */
  undoneEvent: CanvasEventRow | null;
  skipped: UndoSkippedEvent[];
}

/**
 * Reverses the actor's newest still-meaningful event. Candidates a collaborator
 * superseded are skipped so an undo never overwrites their work; candidates
 * that would no longer change the canvas are marked undone and reported as
 * no-ops; selection keeps walking back until an event actually changes the
 * graph or the trail is exhausted.
 *
 * Undo never grants more than the actor may do now: candidates whose original
 * write rule the actor no longer satisfies are skipped as "conflict" (see
 * `undoAuthorized`) and stay un-undone.
 *
 * Lock order: the caller holds the requested canvas row FOR UPDATE; the undo then takes at most the shared
 * entity/connection rows it writes, FOR UPDATE until commit, after its own canvas row (the order PATCH uses).
 * Decision phase (the walk): unlocked reads only, including the blocked-state endpoint check, so no share-class or
 * update lock is ever taken on a candidate that is skipped or a no-op. Apply phase: only the candidate actually
 * being undone locks, either FOR KEY SHARE on the endpoints a restore re-inserts against (re-checking the blocked
 * state under that lock; those undos always write and end the walk, so no FOR UPDATE on the same rows follows) or
 * FOR UPDATE on the object it writes (re-reading write access and the no-op test under the lock). A shared lock is
 * never taken on a row this transaction may later update-lock. The one residual: an entity/connection update that
 * becomes a no-op after its FOR UPDATE was granted, or a restore found blocked under its KEY SHARE, keeps that lock
 * while the walk continues, so a rare cycle remains possible; the route retries the whole transaction on
 * 40P01/40001 (`retryOnLockConflict`) and answers 503 if that keeps failing.
 */
export async function applyNextUndo(tx: Transaction, canvasId: string, actor: Actor): Promise<UndoOutcome> {
  const actorId = actor.id;
  const rows = await tx
    .select()
    .from(canvasEvents)
    .where(
      and(
        eq(canvasEvents.canvasId, canvasId),
        isNull(canvasEvents.undoneAt),
        // Registered actions (canvas.undo by default) are historical records,
        // not reversible actions themselves.
        notInArray(canvasEvents.action, listNonReversibleActions()),
      ),
    )
    // The sequence is monotonic per insert; created_at is clock based and can step backwards.
    .orderBy(desc(canvasEvents.seq), desc(canvasEvents.id))
    .limit(500);
  const skipped: UndoSkippedEvent[] = [];
  for (const [index, candidate] of rows.entries()) {
    if (candidate.actorUserId !== actorId) continue;
    const blocked = !(await undoAuthorized(tx, actor, candidate)) || (await undoBlockedByCurrentState(tx, candidate));
    const affected = await affectedObjectsFor(tx, candidate);
    const conflicted =
      !blocked &&
      rows.slice(0, index).some((later) => later.actorUserId !== actorId && overlaps(affected, affectedObjects(later)));
    if (blocked || conflicted) {
      skipped.push({ action: candidate.action, targetName: candidate.targetName, reason: "conflict" });
      continue;
    }
    // The walk judged this candidate on unlocked reads. Lock the endpoints its restore needs (KEY SHARE, so a
    // concurrent delete cannot slip in before the re-insert) and re-check under that lock. Once the lock is held
    // applyUndo always writes and returns true, so no later FOR UPDATE on those rows follows in this transaction.
    if (await undoBlockedByCurrentState(tx, candidate, true)) {
      skipped.push({ action: candidate.action, targetName: candidate.targetName, reason: "conflict" });
      continue;
    }
    const changed = await applyUndo(tx, candidate, actor);
    if (changed === "refused") {
      // Edit access was lost while waiting for the object lock; nothing was written for this candidate.
      skipped.push({ action: candidate.action, targetName: candidate.targetName, reason: "conflict" });
      continue;
    }
    await markUndone(tx, candidate.id);
    if (!changed) {
      skipped.push({ action: candidate.action, targetName: candidate.targetName, reason: "no-op" });
      continue;
    }
    return { undoneEvent: candidate, skipped };
  }
  return { undoneEvent: null, skipped };
}

/**
 * Re-applies the existing write rules (lib/auth.ts) to the data an undo writes,
 * using the transaction so it sees the same state the undo will change:
 * - canvas.updated: the canvas PATCH rule, canvas manager only (accessGuard
 *   treats PATCH /api/canvases/:canvasId as managerOnly; workspace managers and
 *   system admins resolve to canvas manager in canvasRole).
 * - entity.updated, connection.updated (non-bend): the objectAccess "write"
 *   decision the entity/connection routes enforce, which covers every canvas in
 *   the workspace that now shows the object. A missing object passes through to
 *   the undo's own no-op handling.
 * Everything else needs no extra check: bend, placement and auto-neat undos
 * only touch this canvas, which the route already requires a non-viewer role
 * for. entity.created/connection.created undo only deletes rows no other canvas
 * places, and entity.deleted/connection.deleted undo only inserts missing rows
 * (on conflict do nothing) and this canvas's placements/links, so shared rows
 * that other canvases show are never overwritten.
 */
async function undoAuthorized(tx: Transaction, actor: Actor, event: CanvasEventRow): Promise<boolean> {
  switch (event.action) {
    case "canvas.updated":
      return (await canvasRole(actor, event.canvasId, tx)) === "manager";
    case "entity.updated":
      return !event.targetId || (await objectAccess(actor, "entity", event.targetId, "write", tx)) !== "denied";
    case "connection.updated": {
      const metadata = (event.metadata ?? {}) as Record<string, unknown>;
      if (metadata.field === "bend") return true;
      return !event.targetId || (await objectAccess(actor, "connection", event.targetId, "write", tx)) !== "denied";
    }
    default:
      return true;
  }
}

/**
 * Entities among `ids` that still exist. With `lock` they are read FOR KEY SHARE (ascending id order) so a concurrent delete cannot slip between this
 * check and the restore that re-inserts rows referencing them (which would fail the foreign key with a 500).
 * A delete already in flight makes this wait, then see the row gone.
 */
async function existingEntities(tx: Transaction, ids: string[], lock: boolean): Promise<Array<{ id: string }>> {
  const query = tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids));
  return lock ? query.orderBy(asc(entities.id)).for("key share") : query;
}

/**
 * State-based guard for events that can no longer be reversed regardless of
 * who changed what since. Restoring a deleted connector requires both endpoint
 * entities to still exist; a collaborator's own undo may have removed one, and
 * the connections foreign keys would reject the restore. The same applies to
 * restoring a deleted subtree whose snapshot connectors point at endpoints
 * that were removed after the fact.
 *
 * The candidate walk calls this unlocked (`lock` false). Only the candidate about to be applied calls it again
 * with `lock` true, which takes FOR KEY SHARE on the endpoints it needs and keeps them to commit.
 */
async function undoBlockedByCurrentState(tx: Transaction, event: CanvasEventRow, lock = false): Promise<boolean> {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  if (event.action === "connection.deleted") {
    const connection = snapshotValue<ConnectionSnapshot | undefined>(metadata, "connection");
    const endpointIds = [connection?.sourceEntityId, connection?.targetEntityId].filter(
      (id): id is string => typeof id === "string",
    );
    if (!endpointIds.length) return false;
    const existing = await existingEntities(tx, endpointIds, lock);
    return existing.length !== endpointIds.length;
  }
  if (event.action === "entity.deleted") {
    const snapshot = snapshotValue<Record<string, unknown> | undefined>(metadata, "snapshot");
    const connectionRows = Array.isArray(snapshot?.connections)
      ? (snapshot.connections as Array<{ sourceEntityId?: unknown; targetEntityId?: unknown }>)
      : [];
    const endpointIds = new Set<string>();
    for (const row of connectionRows) {
      for (const id of [row?.sourceEntityId, row?.targetEntityId]) {
        if (typeof id === "string") endpointIds.add(id);
      }
    }
    if (!endpointIds.size) return false;
    // Endpoints restored by the snapshot itself are safe: entities are
    // re-inserted before their connectors.
    const restored = new Set(
      Array.isArray(snapshot?.entities)
        ? (snapshot.entities as Array<{ id?: unknown }>)
            .map((entity) => (entity && typeof entity.id === "string" ? entity.id : null))
            .filter((id): id is string => id !== null)
        : [],
    );
    const toCheck = [...endpointIds].filter((id) => !restored.has(id));
    if (!toCheck.length) return false;
    const existing = await existingEntities(tx, toCheck, lock);
    return existing.length !== toCheck.length;
  }
  if (event.action === "canvas.auto_neat") {
    // Restoring placements re-inserts canvas_nodes rows whose entity foreign
    // keys must still exist; a collaborator's undo may have removed one.
    const entityIds = [
      ...new Set(
        autoNeatPrevious(metadata)
          .placements.map((placement) => placement?.entityId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (!entityIds.length) return false;
    const existing = await existingEntities(tx, entityIds, lock);
    return existing.length !== entityIds.length;
  }
  if (event.action === "placement.updated") {
    const entries =
      snapshotValue<
        Array<{ from?: { entityId?: unknown; parentEntityId?: unknown } | null; entityId?: unknown } | undefined>
      >(metadata, "placements") ?? [];
    // Restoring placements re-inserts canvas_nodes rows whose entity foreign
    // keys must still exist; a collaborator's undo may have removed one.
    const restoredIds = [
      ...new Set(entries.map((entry) => entry?.from?.entityId).filter((id): id is string => typeof id === "string")),
    ];
    if (restoredIds.length) {
      const existing = await existingEntities(tx, restoredIds, lock);
      if (existing.length !== restoredIds.length) return true;
    }
    // Placements this event added (from: null) get deleted by the undo.
    // Collaborators may depend on them: a connector attached to the node or a
    // child node parented underneath it would be left dangling, so the
    // candidate must be skipped instead.
    const addedIds = [
      ...new Set(
        entries
          .filter(
            (entry): entry is { from: null; entityId: string } =>
              !!entry && entry.from === null && typeof entry.entityId === "string",
          )
          .map((entry) => entry.entityId),
      ),
    ];
    if (addedIds.length) {
      const [attached] = await tx
        .select({ id: connections.id })
        .from(canvasConnections)
        .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
        .where(
          and(
            eq(canvasConnections.canvasId, event.canvasId),
            or(inArray(connections.sourceEntityId, addedIds), inArray(connections.targetEntityId, addedIds)),
          ),
        )
        .limit(1);
      if (attached) return true;
      // Judge children by the state after the whole event is reversed, not by
      // the current one. Children the same event added are removed by the undo
      // itself, and children the event re-parented move back to their snapshot
      // parent, so neither is a live dependency. Only a child that survives
      // the undo and still points at a deleted parent blocks it.
      const addedSet = new Set(addedIds);
      const previousParentByEntityId = new Map<string, string | null>();
      for (const entry of entries) {
        if (!entry?.from || typeof entry.entityId !== "string") continue;
        previousParentByEntityId.set(
          entry.entityId,
          typeof entry.from.parentEntityId === "string" ? entry.from.parentEntityId : null,
        );
      }
      const children = await tx
        .select({ entityId: canvasNodes.entityId, parentEntityId: canvasNodes.parentEntityId })
        .from(canvasNodes)
        .where(and(eq(canvasNodes.canvasId, event.canvasId), inArray(canvasNodes.parentEntityId, addedIds)));
      for (const child of children) {
        if (addedSet.has(child.entityId)) continue;
        const previousParent = previousParentByEntityId.get(child.entityId);
        // No entry in this event means the child was attached afterwards and
        // the undo leaves it dangling; a snapshot parent that is itself being
        // deleted stays dependent too.
        if (previousParent === undefined) return true;
        if (previousParent !== null && addedSet.has(previousParent)) return true;
      }
    }
    return false;
  }
  return false;
}

interface AffectedObjects {
  entityIds: Set<string>;
  connectionIds: Set<string>;
  canvasFields: Set<string>;
  /**
   * Field-level scope for version 2 updates, keyed by object id. An id with an
   * entry here is touched only on these fields; ids without one are touched wholesale.
   */
  touched: Map<string, Set<string>>;
}

const CANVAS_FIELDS = ["name", "description", "shareMode"] as const;

function canvasUpdatedFields(metadata: Record<string, unknown>): Set<string> {
  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const known = CANVAS_FIELDS as readonly string[];
  const selected = new Set(
    fields.filter((field): field is string => typeof field === "string" && known.includes(field)),
  );
  // Rows recorded before the field list existed restore every canvas field.
  return selected.size ? selected : new Set(CANVAS_FIELDS);
}

function affectedObjects(event: CanvasEventRow): AffectedObjects {
  const affected: AffectedObjects = {
    entityIds: new Set(),
    connectionIds: new Set(),
    canvasFields: new Set(),
    touched: new Map(),
  };
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  switch (event.action) {
    case "entity.created":
      if (event.targetId) affected.entityIds.add(event.targetId);
      break;
    case "entity.updated":
      if (event.targetId) {
        affected.entityIds.add(event.targetId);
        if (isUpdateEventMetadataV2(metadata)) affected.touched.set(event.targetId, touchedKeys(metadata));
      }
      break;
    case "entity.deleted": {
      // Undoing a delete restores the whole recorded subtree.
      if (event.targetId) affected.entityIds.add(event.targetId);
      const snapshot = snapshotValue<Record<string, unknown> | undefined>(metadata, "snapshot");
      for (const entity of Array.isArray(snapshot?.entities) ? (snapshot.entities as Array<{ id?: unknown }>) : []) {
        if (entity && typeof entity.id === "string") affected.entityIds.add(entity.id);
      }
      for (const connection of Array.isArray(snapshot?.connections)
        ? (snapshot.connections as Array<{ id?: unknown }>)
        : []) {
        if (connection && typeof connection.id === "string") affected.connectionIds.add(connection.id);
      }
      break;
    }
    case "connection.created":
    case "connection.deleted":
      if (event.targetId) affected.connectionIds.add(event.targetId);
      break;
    case "connection.updated":
      if (event.targetId) {
        affected.connectionIds.add(event.targetId);
        if (isUpdateEventMetadataV2(metadata)) affected.touched.set(event.targetId, touchedKeys(metadata));
      }
      break;
    case "placement.updated": {
      const entries = snapshotValue<Array<{ entityId?: unknown }> | undefined>(metadata, "placements") ?? [];
      for (const entry of entries) {
        if (entry && typeof entry.entityId === "string") affected.entityIds.add(entry.entityId);
      }
      break;
    }
    case "canvas.auto_neat": {
      const previous = autoNeatPrevious(metadata);
      for (const placement of previous.placements) {
        if (placement && typeof placement.entityId === "string") affected.entityIds.add(placement.entityId);
      }
      for (const link of previous.connections) {
        if (link && typeof link.connectionId === "string") affected.connectionIds.add(link.connectionId);
      }
      break;
    }
    case "canvas.updated":
      for (const field of canvasUpdatedFields(metadata)) affected.canvasFields.add(field);
      break;
  }
  return affected;
}

async function affectedObjectsFor(tx: Transaction, event: CanvasEventRow): Promise<AffectedObjects> {
  const affected = affectedObjects(event);
  // Undoing a creation deletes the whole current subtree, so anything a
  // collaborator attached under the node afterwards also counts as affected.
  if (event.action === "entity.created" && event.targetId) {
    const placements = await tx
      .select({ entityId: canvasNodes.entityId, parentEntityId: canvasNodes.parentEntityId })
      .from(canvasNodes)
      .where(eq(canvasNodes.canvasId, event.canvasId));
    const subtree = subtreeIds(placements, event.targetId);
    for (const id of subtree) affected.entityIds.add(id);
    // The undo also deletes every connector attached to the subtree; connectors
    // collaborators created after this event must block it.
    const attached = await tx
      .select({ id: connections.id })
      .from(canvasConnections)
      .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
      .where(
        and(
          eq(canvasConnections.canvasId, event.canvasId),
          or(inArray(connections.sourceEntityId, subtree), inArray(connections.targetEntityId, subtree)),
        ),
      );
    for (const link of attached) affected.connectionIds.add(link.id);
  }
  return affected;
}

/**
 * Fields and "metadata.<key>" entries a version 2 update touches. Externally
 * managed metadata keys are owned by another subsystem. Documentation still
 * counts for conflicts because canvas undo delegates its legacy restoration.
 */
function touchedKeys(metadata: Record<string, unknown>): Set<string> {
  const touched = new Set<string>();
  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  for (const field of fields) if (typeof field === "string" && field !== "metadata") touched.add(field);
  const previousMetadata = (metadata.previousMetadata ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(previousMetadata)) if (!isExternalMetadataKey(key)) touched.add(`metadata.${key}`);
  if (documentationUndoEntry(metadata) !== undefined) touched.add(`metadata.${DOCUMENTATION_KEY}`);
  return touched;
}

function sharedObjectConflicts(a: AffectedObjects, b: AffectedObjects, ids: Set<string>, other: Set<string>): boolean {
  for (const id of ids) {
    if (!other.has(id)) continue;
    const mine = a.touched.get(id);
    const theirs = b.touched.get(id);
    // Field-level comparison only when both sides are version 2 updates.
    if (!mine || !theirs) return true;
    for (const key of mine) if (theirs.has(key)) return true;
  }
  return false;
}

function overlaps(a: AffectedObjects, b: AffectedObjects): boolean {
  if (sharedObjectConflicts(a, b, a.entityIds, b.entityIds)) return true;
  if (sharedObjectConflicts(a, b, a.connectionIds, b.connectionIds)) return true;
  for (const field of a.canvasFields) if (b.canvasFields.has(field)) return true;
  return false;
}

/**
 * Reverses a recorded canvas event inside the caller's transaction.
 * Snapshots captured when the event was recorded are the source of truth;
 * re-inserts stay conflict-tolerant because collaborators may have recreated
 * rows. Returns whether the reversal actually changed anything; a `false`
 * result means the event's objects were already gone, so the undo is a no-op.
 */
async function applyUndo(tx: Transaction, event: CanvasEventRow, actor: Actor): Promise<boolean | "refused"> {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  switch (event.action) {
    case "placement.updated": {
      const entries =
        snapshotValue<Array<{ from: PlacementSnapshot | null; entityId?: unknown }> | undefined>(
          metadata,
          "placements",
        ) ?? [];
      const restorable = entries
        .map((entry) => entry?.from)
        .filter((placement): placement is PlacementSnapshot => placement !== null);
      // Entries with no previous state are placements this event added; their
      // undo removes them again.
      const addedIds = [
        ...new Set(
          entries
            .filter((entry) => entry && entry.from === null && typeof entry.entityId === "string")
            .map((entry) => entry.entityId as string),
        ),
      ];
      if (!restorable.length && !addedIds.length) return false;
      let changed = false;
      if (restorable.length) {
        await restorePlacements(tx, event.canvasId, restorable);
        changed = true;
      }
      for (const entityId of addedIds) {
        const removed = await tx
          .delete(canvasNodes)
          .where(and(eq(canvasNodes.canvasId, event.canvasId), eq(canvasNodes.entityId, entityId)))
          .returning({ entityId: canvasNodes.entityId });
        if (removed.length) changed = true;
      }
      return changed;
    }
    case "entity.created":
      return deleteEntitySubtree(tx, event.canvasId, requireTargetId(event));
    case "connection.created":
      return deleteConnection(tx, event.canvasId, requireTargetId(event));
    case "entity.updated": {
      const entityId = requireTargetId(event);
      const ref: DocumentRef = { kind: "entity", id: entityId };
      const entry = documentationUndoEntry(metadata);
      // No-op candidates must stay lock-free (see the lock order on applyNextUndo): decide on an unlocked read.
      const [seen] = await tx.select().from(entities).where(eq(entities.id, entityId)).limit(1);
      if (!seen || (!entityRestore(seen, metadata) && !(await documentationWouldChange(tx, ref, seen.metadata, entry))))
        return false;
      // A write is needed. Lock order: canvas row(s) first (the route holds the requested canvas), then this shared
      // entity row, the same as PATCH /api/entities/:id. Held to commit so the read-modify-write cannot lose a
      // concurrent undo or edit that reached the entity through another canvas; taken FOR UPDATE up front (never
      // FOR SHARE first) so event recording cannot need a lock upgrade.
      const [current] = await tx.select().from(entities).where(eq(entities.id, entityId)).for("update").limit(1);
      if (!current) return false;
      // The wait may have let a placement on a canvas the actor cannot edit commit; judge write access again.
      if (!(await undoAuthorized(tx, actor, event))) return "refused";
      const plan = entityRestore(current, metadata);
      // Became a no-op while waiting for the lock: nothing to write.
      if (!plan && !(await documentationWouldChange(tx, ref, current.metadata, entry))) return false;
      await tx
        .update(entities)
        .set({
          ...(plan ? { ...plan.next, metadata: plan.nextMetadata as EntityMetadata } : {}),
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));
      if (entry !== undefined || (await isBootstrapped(tx, ref))) await restoreDocumentation(tx, ref, entry);
      return true;
    }
    case "connection.updated":
      return undoConnectionUpdated(tx, event, actor, requireTargetId(event), metadata);
    case "canvas.updated": {
      // Restore only the fields this event changed so collaborators' edits to
      // other canvas fields survive the undo.
      const fields = canvasUpdatedFields(metadata);
      const [current] = await tx
        .select({ name: canvases.name, description: canvases.description, shareMode: canvases.shareMode })
        .from(canvases)
        .where(eq(canvases.id, event.canvasId))
        .limit(1);
      if (!current) return false;
      const patch: {
        name?: string;
        description?: string;
        shareMode?: "restricted" | "link";
      } = {};
      if (fields.has("name")) patch.name = previousField<string>(metadata, "name", current.name);
      if (fields.has("description"))
        patch.description = previousField<string>(metadata, "description", current.description);
      if (fields.has("shareMode"))
        patch.shareMode = previousField<"restricted" | "link">(metadata, "shareMode", current.shareMode);
      const identical = Object.entries(patch).every(
        ([field, value]) => current[field as keyof typeof current] === value,
      );
      if (identical) return false;
      await tx
        .update(canvases)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(canvases.id, event.canvasId));
      return true;
    }
    case "connection.deleted": {
      const connection = snapshotValue<ConnectionSnapshot | undefined>(metadata, "connection");
      const restored = await restoreConnection(tx, event.canvasId, connection, metadata[DOCUMENTATION_SNAPSHOT_KEY]);
      if (restored && connection)
        await restoreDeleteHooks(tx, { kind: "connection", ids: [connection.id] }, metadata.hooks);
      return restored;
    }
    case "entity.deleted": {
      const snapshot = snapshotValue<Record<string, unknown>>(metadata, "snapshot") ?? {};
      const restored = await restoreEntitySubtree(tx, event.canvasId, snapshot);
      if (restored) {
        const ids = (Array.isArray(snapshot.entities) ? (snapshot.entities as Array<{ id?: unknown }>) : [])
          .map((entity) => entity?.id)
          .filter((id): id is string => typeof id === "string");
        await restoreDeleteHooks(tx, { kind: "entity", ids }, metadata.hooks);
      }
      return restored;
    }
    case "canvas.auto_neat": {
      const previous = autoNeatPrevious(metadata);
      if (!previous.placements.length && !previous.connections.length) return false;
      await restorePlacements(tx, event.canvasId, previous.placements);
      for (const link of previous.connections) {
        await tx
          .update(canvasConnections)
          .set({ bend: link.bend })
          .where(
            and(eq(canvasConnections.canvasId, event.canvasId), eq(canvasConnections.connectionId, link.connectionId)),
          );
      }
      return true;
    }
  }
  // canvas.undo entries are never candidates; treat any other unknown action
  // as a no-op rather than claiming a change.
  return false;
}

function requireTargetId(event: CanvasEventRow): string {
  if (!event.targetId) throw new Error(`Event ${event.id} has no target id`);
  return event.targetId;
}

function autoNeatPrevious(metadata: Record<string, unknown>): {
  placements: PlacementSnapshot[];
  connections: Array<{ connectionId: string; bend: ConnectionPath }>;
} {
  // The route stores the pre-neat state under metadata.previous; fall back to a
  // flat layout so rows written by older builds still undo.
  const source = (snapshotValue<Record<string, unknown> | undefined>(metadata, "previous") ?? metadata) as Record<
    string,
    unknown
  >;
  return {
    placements: Array.isArray(source.placements) ? (source.placements as PlacementSnapshot[]) : [],
    connections: Array.isArray(source.connections)
      ? (source.connections as Array<{ connectionId: string; bend: ConnectionPath }>)
      : [],
  };
}

function snapshotValue<T>(metadata: Record<string, unknown>, field: string): T {
  return (metadata[field] ?? undefined) as T;
}

/** No-op checks must read bootstrap state without locking during the undo walk. */
async function documentationWouldChange(
  tx: Transaction,
  ref: DocumentRef,
  current: Record<string, unknown>,
  entry: PreviousMetadataEntry | undefined,
): Promise<boolean> {
  if (entry === undefined || (await isBootstrapped(tx, ref))) return false;
  const previous: PreviousMetadataEntry = Object.hasOwn(current, DOCUMENTATION_KEY)
    ? { present: true, value: current[DOCUMENTATION_KEY] }
    : { present: false };
  return !isDeepStrictEqual(previous, entry);
}

/** New delete sections take precedence over documentation embedded in historical row snapshots. */
function deletedDocumentationEntry(
  section: unknown,
  ref: DocumentRef,
  metadata: Record<string, unknown>,
): PreviousMetadataEntry | undefined {
  const entries = section as Record<string, PreviousMetadataEntry> | undefined;
  return (
    entries?.[`${ref.kind}:${ref.id}`] ??
    (Object.hasOwn(metadata, DOCUMENTATION_KEY) ? { present: true, value: metadata[DOCUMENTATION_KEY] } : undefined)
  );
}

function previousField<T>(metadata: Record<string, unknown>, field: string, fallback: T): T {
  const snapshot = metadata.previous as Record<string, unknown> | undefined;
  const value = snapshot?.[field];
  return (value === undefined || value === null ? fallback : value) as T;
}

function previousNullableField(metadata: Record<string, unknown>, field: string): string | null {
  const snapshot = metadata.previous as Record<string, unknown> | undefined;
  const value = snapshot?.[field];
  return typeof value === "string" ? value : null;
}

async function restorePlacements(tx: Transaction, canvasId: string, placements: PlacementSnapshot[]) {
  if (!placements.length) return;
  await tx
    .insert(canvasNodes)
    .values(placements.map((placement) => ({ canvasId, ...placement })))
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
}

/** The values an entity.updated undo would write over `current`, or null when they equal what is stored. */
function entityRestore(
  current: typeof entities.$inferSelect,
  metadata: Record<string, unknown>,
): {
  next: { type: EntityType; name: string; description: string | null };
  nextMetadata: Record<string, unknown>;
} | null {
  const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;
  let next: { type: EntityType; name: string; description: string | null };
  let nextMetadata: Record<string, unknown>;
  if (isUpdateEventMetadataV2(metadata)) {
    next = {
      type: v2String(metadata, "type", current.type) as EntityType,
      name: v2String(metadata, "name", current.name),
      description: v2Description(metadata, current.description),
    };
    nextMetadata = applyPreviousMetadata(currentMetadata, metadata.previousMetadata);
  } else {
    next = {
      type: previousField<EntityType>(metadata, "type", current.type),
      name: previousField<string>(metadata, "name", current.name),
      description: previousNullableField(metadata, "description"),
    };
    nextMetadata = legacyMetadata(
      currentMetadata,
      previousField<Record<string, unknown>>(metadata, "metadata", current.metadata as Record<string, unknown>),
    );
  }
  if (
    current.type === next.type &&
    current.name === next.name &&
    current.description === next.description &&
    JSON.stringify(sortKeys(currentMetadata)) === JSON.stringify(sortKeys(nextMetadata))
  )
    return null;
  return { next, nextMetadata };
}

/** The values a connection.updated undo would write over `current`, or null when they equal what is stored. */
function connectionRestore(
  current: typeof connections.$inferSelect,
  metadata: Record<string, unknown>,
): {
  next: { type: ConnectionType; label: string; description: string | null };
  nextMetadata: Record<string, unknown>;
} | null {
  const currentMetadata = (current.metadata ?? {}) as Record<string, unknown>;
  let next: { type: ConnectionType; label: string; description: string | null };
  let nextMetadata: Record<string, unknown>;
  if (isUpdateEventMetadataV2(metadata)) {
    next = {
      type: v2String(metadata, "type", current.type) as ConnectionType,
      label: v2String(metadata, "label", current.label),
      description: v2Description(metadata, current.description),
    };
    nextMetadata = applyPreviousMetadata(currentMetadata, metadata.previousMetadata);
  } else {
    next = {
      type: previousField<ConnectionType>(metadata, "type", current.type),
      label: previousField<string>(metadata, "label", current.label),
      description: previousNullableField(metadata, "description"),
    };
    nextMetadata = legacyMetadata(
      currentMetadata,
      previousField<Record<string, unknown>>(metadata, "metadata", current.metadata),
    );
  }
  if (
    current.type === next.type &&
    current.label === next.label &&
    current.description === next.description &&
    JSON.stringify(sortKeys(currentMetadata)) === JSON.stringify(sortKeys(nextMetadata))
  )
    return null;
  return { next, nextMetadata };
}

async function deleteEntitySubtree(tx: Transaction, canvasId: string, entityId: string): Promise<boolean> {
  const placements = await tx
    .select({ entityId: canvasNodes.entityId, parentEntityId: canvasNodes.parentEntityId })
    .from(canvasNodes)
    .where(eq(canvasNodes.canvasId, canvasId));
  if (!placements.some((item) => item.entityId === entityId)) return false;
  const entityIds = subtreeIds(placements, entityId);
  const affectedLinks = await tx
    .select({ id: connections.id })
    .from(canvasConnections)
    .innerJoin(connections, eq(canvasConnections.connectionId, connections.id))
    .where(
      and(
        eq(canvasConnections.canvasId, canvasId),
        or(inArray(connections.sourceEntityId, entityIds), inArray(connections.targetEntityId, entityIds)),
      ),
    );
  const linkIds = affectedLinks.map((item) => item.id);
  if (linkIds.length)
    await tx
      .delete(canvasConnections)
      .where(and(eq(canvasConnections.canvasId, canvasId), inArray(canvasConnections.connectionId, linkIds)));
  await tx.delete(canvasNodes).where(and(eq(canvasNodes.canvasId, canvasId), inArray(canvasNodes.entityId, entityIds)));
  // Lock each shared row before asking whether another canvas still shows it: a placement or link insert takes
  // KEY SHARE on the row it references, so it either finishes first (and is seen below) or waits until we commit
  // (and then fails its foreign key instead of being silently cascade-deleted with the row). Ascending id order.
  await lockRows(tx, connections, connections.id, linkIds);
  for (const id of linkIds) {
    const [stillUsed] = await tx
      .select({ id: canvasConnections.connectionId })
      .from(canvasConnections)
      .where(eq(canvasConnections.connectionId, id))
      .limit(1);
    if (!stillUsed) await tx.delete(connections).where(eq(connections.id, id));
  }
  await lockRows(tx, entities, entities.id, entityIds);
  for (const id of entityIds) {
    const [stillPlaced] = await tx
      .select({ id: canvasNodes.entityId })
      .from(canvasNodes)
      .where(eq(canvasNodes.entityId, id))
      .limit(1);
    if (!stillPlaced) await tx.delete(entities).where(eq(entities.id, id));
  }
  await touchCanvas(tx, canvasId);
  return true;
}

async function deleteConnection(tx: Transaction, canvasId: string, connectionId: string): Promise<boolean> {
  const [removed] = await tx
    .delete(canvasConnections)
    .where(and(eq(canvasConnections.canvasId, canvasId), eq(canvasConnections.connectionId, connectionId)))
    .returning({ connectionId: canvasConnections.connectionId });
  if (!removed) return false;
  await lockRows(tx, connections, connections.id, [connectionId]);
  const [stillUsed] = await tx
    .select({ id: canvasConnections.connectionId })
    .from(canvasConnections)
    .where(eq(canvasConnections.connectionId, connectionId))
    .limit(1);
  if (!stillUsed) await tx.delete(connections).where(eq(connections.id, connectionId));
  await touchCanvas(tx, canvasId);
  return true;
}

/** Row-locks the given ids in ascending order (see deleteEntitySubtree for why). */
async function lockRows(
  tx: Transaction,
  table: typeof entities | typeof connections,
  idColumn: typeof entities.id | typeof connections.id,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  await tx.select({ id: idColumn }).from(table).where(inArray(idColumn, ids)).orderBy(asc(idColumn)).for("update");
}

async function restoreConnection(
  tx: Transaction,
  canvasId: string,
  connection: ConnectionSnapshot | undefined,
  documentation: unknown,
): Promise<boolean> {
  if (!connection) return false;
  const inserted = await tx
    .insert(connections)
    .values({ ...connection, metadata: withoutDocumentation(connection.metadata) })
    .onConflictDoNothing()
    .returning({ id: connections.id });
  await tx
    .insert(canvasConnections)
    .values({ canvasId, connectionId: connection.id, bend: connection.bend })
    .onConflictDoUpdate({
      target: [canvasConnections.canvasId, canvasConnections.connectionId],
      set: { bend: connection.bend },
    });
  if (inserted.length) {
    const ref: DocumentRef = { kind: "connection", id: connection.id };
    await restoreDocumentation(tx, ref, deletedDocumentationEntry(documentation, ref, connection.metadata));
  }
  await touchCanvas(tx, canvasId);
  return true;
}

async function restoreEntitySubtree(
  tx: Transaction,
  canvasId: string,
  snapshot: Record<string, unknown>,
): Promise<boolean> {
  const entityRows = Array.isArray(snapshot.entities) ? (snapshot.entities as EntitySnapshot[]) : [];
  const connectionRows = Array.isArray(snapshot.connections) ? (snapshot.connections as ConnectionSnapshot[]) : [];
  const placements = Array.isArray(snapshot.placements) ? (snapshot.placements as PlacementSnapshot[]) : [];
  if (!entityRows.length && !connectionRows.length && !placements.length) return false;
  const restoredOwners: Array<{ ref: DocumentRef; metadata: Record<string, unknown> }> = [];
  if (entityRows.length) {
    const inserted = await tx
      .insert(entities)
      .values(entityRows.map((entity) => ({ ...entity, metadata: withoutDocumentation(entity.metadata) })))
      .onConflictDoNothing()
      .returning({ id: entities.id });
    const insertedIds = new Set(inserted.map((row) => row.id));
    for (const entity of entityRows) {
      if (insertedIds.has(entity.id))
        restoredOwners.push({ ref: { kind: "entity", id: entity.id }, metadata: entity.metadata });
    }
  }
  if (connectionRows.length) {
    const inserted = await tx
      .insert(connections)
      .values(
        connectionRows.map(({ bend: _bend, ...connection }) => ({
          ...connection,
          metadata: withoutDocumentation(connection.metadata),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: connections.id });
    const insertedIds = new Set(inserted.map((row) => row.id));
    for (const connection of connectionRows) {
      if (insertedIds.has(connection.id))
        restoredOwners.push({ ref: { kind: "connection", id: connection.id }, metadata: connection.metadata });
    }
    for (const connection of connectionRows) {
      await tx
        .insert(canvasConnections)
        .values({ canvasId, connectionId: connection.id, bend: connection.bend })
        .onConflictDoUpdate({
          target: [canvasConnections.canvasId, canvasConnections.connectionId],
          set: { bend: connection.bend },
        });
    }
  }
  await restorePlacements(tx, canvasId, placements);
  for (const { ref, metadata } of restoredOwners) {
    await restoreDocumentation(tx, ref, deletedDocumentationEntry(snapshot[DOCUMENTATION_SNAPSHOT_KEY], ref, metadata));
  }
  await touchCanvas(tx, canvasId);
  return true;
}

async function undoConnectionUpdated(
  tx: Transaction,
  event: CanvasEventRow,
  actor: Actor,
  connectionId: string,
  metadata: Record<string, unknown>,
): Promise<boolean | "refused"> {
  const canvasId = event.canvasId;
  if (metadata.field === "bend") {
    const bend = (metadata.previousBend ?? null) as ConnectionPath;
    const [current] = await tx
      .select({ bend: canvasConnections.bend })
      .from(canvasConnections)
      .where(and(eq(canvasConnections.canvasId, canvasId), eq(canvasConnections.connectionId, connectionId)))
      .limit(1);
    if (!current) return false;
    if (JSON.stringify(current.bend ?? null) === JSON.stringify(bend ?? null)) return false;
    await tx
      .update(canvasConnections)
      .set({ bend })
      .where(and(eq(canvasConnections.canvasId, canvasId), eq(canvasConnections.connectionId, connectionId)));
    await touchCanvas(tx, canvasId);
    return true;
  }
  // Same discipline as entity.updated: decide no-ops on an unlocked read, then take the shared connection row FOR
  // UPDATE (canvas row first, held to commit; matches PATCH /api/connections/:id) only for a real write.
  const ref: DocumentRef = { kind: "connection", id: connectionId };
  const entry = documentationUndoEntry(metadata);
  const [seen] = await tx.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  if (!seen || (!connectionRestore(seen, metadata) && !(await documentationWouldChange(tx, ref, seen.metadata, entry))))
    return false;
  const [current] = await tx.select().from(connections).where(eq(connections.id, connectionId)).for("update").limit(1);
  if (!current) return false;
  if (!(await undoAuthorized(tx, actor, event))) return "refused";
  const plan = connectionRestore(current, metadata);
  if (!plan && !(await documentationWouldChange(tx, ref, current.metadata, entry))) return false;
  if (plan) {
    await tx
      .update(connections)
      .set({ ...plan.next, metadata: plan.nextMetadata })
      .where(eq(connections.id, connectionId));
  }
  if (entry !== undefined || (await isBootstrapped(tx, ref))) await restoreDocumentation(tx, ref, entry);
  await touchCanvas(tx, canvasId);
  return true;
}

/** Version 2: restore a top-level string field only when the event recorded it. */
function v2String(metadata: Record<string, unknown>, field: string, fallback: string): string {
  const previous = (metadata.previous ?? {}) as Record<string, unknown>;
  const value = previous[field];
  return typeof value === "string" ? value : fallback;
}

/** Version 2: description is restored (including back to null) only when the event recorded it. */
function v2Description(metadata: Record<string, unknown>, fallback: string | null): string | null {
  const previous = (metadata.previous ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(previous, "description")) return fallback;
  return typeof previous.description === "string" ? previous.description : null;
}

/**
 * Version 2: starts from the current metadata and rewrites only the recorded
 * keys. Absent keys are deleted, present keys (including null) are restored.
 * Externally managed keys are ignored.
 */
function applyPreviousMetadata(
  current: Record<string, unknown>,
  previousMetadata: Record<string, PreviousMetadataEntry> | undefined,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, entry] of Object.entries(previousMetadata ?? {})) {
    if (isExternalMetadataKey(key)) continue;
    if (entry?.present === true) next[key] = entry.value;
    else if (entry?.present === false) delete next[key];
  }
  return next;
}

/**
 * Legacy full-snapshot restore, except externally managed keys keep their
 * current values (or stay absent when currently absent).
 */
function legacyMetadata(current: Record<string, unknown>, snapshot: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot ?? {})) if (!isExternalMetadataKey(key)) next[key] = value;
  for (const [key, value] of Object.entries(current)) if (isExternalMetadataKey(key)) next[key] = value;
  return next;
}

/** Key-order independent form so jsonb round trips compare equal. */
function sortKeys(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function touchCanvas(tx: Transaction, canvasId: string) {
  await tx.update(canvases).set({ updatedAt: new Date() }).where(eq(canvases.id, canvasId));
}

function subtreeIds(
  placements: Array<Pick<PlacementSnapshot, "entityId" | "parentEntityId">>,
  rootId: string,
): string[] {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const placement of placements) {
      if (placement.parentEntityId && ids.has(placement.parentEntityId) && !ids.has(placement.entityId)) {
        ids.add(placement.entityId);
        changed = true;
      }
    }
  }
  return [...ids];
}
