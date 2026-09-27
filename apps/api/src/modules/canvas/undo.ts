import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  canvases,
  canvasConnections,
  canvasEvents,
  canvasNodes,
  connections,
  entities,
  type CanvasEventAction,
  type db,
} from "@wooble/db";
import type { ConnectionPath, ConnectionType, EntityMetadata, EntityType } from "@wooble/domain";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
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
 */
export async function applyNextUndo(tx: Transaction, canvasId: string, actorId: string): Promise<UndoOutcome> {
  const rows = await tx
    .select()
    .from(canvasEvents)
    .where(
      and(
        eq(canvasEvents.canvasId, canvasId),
        isNull(canvasEvents.undoneAt),
        // Undo entries are historical records, not reversible actions themselves.
        ne(canvasEvents.action, "canvas.undo"),
      ),
    )
    .orderBy(desc(canvasEvents.createdAt), desc(canvasEvents.id))
    .limit(500);
  const skipped: UndoSkippedEvent[] = [];
  for (const [index, candidate] of rows.entries()) {
    if (candidate.actorUserId !== actorId) continue;
    const blocked = await undoBlockedByCurrentState(tx, candidate);
    const affected = await affectedObjectsFor(tx, candidate);
    const conflicted =
      !blocked &&
      rows.slice(0, index).some((later) => later.actorUserId !== actorId && overlaps(affected, affectedObjects(later)));
    if (blocked || conflicted) {
      skipped.push({ action: candidate.action, targetName: candidate.targetName, reason: "conflict" });
      continue;
    }
    const changed = await applyUndo(tx, candidate);
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
 * State-based guard for events that can no longer be reversed regardless of
 * who changed what since. Restoring a deleted connector requires both endpoint
 * entities to still exist; a collaborator's own undo may have removed one, and
 * the connections foreign keys would reject the restore. The same applies to
 * restoring a deleted subtree whose snapshot connectors point at endpoints
 * that were removed after the fact.
 */
async function undoBlockedByCurrentState(tx: Transaction, event: CanvasEventRow): Promise<boolean> {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  if (event.action === "connection.deleted") {
    const connection = snapshotValue<ConnectionSnapshot | undefined>(metadata, "connection");
    const endpointIds = [connection?.sourceEntityId, connection?.targetEntityId].filter(
      (id): id is string => typeof id === "string",
    );
    if (!endpointIds.length) return false;
    const existing = await tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, endpointIds));
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
    const existing = await tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, toCheck));
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
    const existing = await tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, entityIds));
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
      const existing = await tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, restoredIds));
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
  const affected: AffectedObjects = { entityIds: new Set(), connectionIds: new Set(), canvasFields: new Set() };
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  switch (event.action) {
    case "entity.created":
    case "entity.updated":
      if (event.targetId) affected.entityIds.add(event.targetId);
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
    case "connection.updated":
    case "connection.deleted":
      if (event.targetId) affected.connectionIds.add(event.targetId);
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

function overlaps(a: AffectedObjects, b: AffectedObjects): boolean {
  for (const id of a.entityIds) if (b.entityIds.has(id)) return true;
  for (const id of a.connectionIds) if (b.connectionIds.has(id)) return true;
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
async function applyUndo(tx: Transaction, event: CanvasEventRow): Promise<boolean> {
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
      const [current] = await tx.select().from(entities).where(eq(entities.id, entityId)).limit(1);
      if (!current) return false;
      const next = {
        type: previousField<EntityType>(metadata, "type", current.type),
        name: previousField<string>(metadata, "name", current.name),
        description: previousNullableField(metadata, "description"),
        metadata: previousField<EntityMetadata>(metadata, "metadata", current.metadata),
      };
      if (
        current.type === next.type &&
        current.name === next.name &&
        current.description === next.description &&
        JSON.stringify(current.metadata ?? {}) === JSON.stringify(next.metadata ?? {})
      )
        return false;
      await tx
        .update(entities)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(entities.id, entityId));
      return true;
    }
    case "connection.updated":
      return undoConnectionUpdated(tx, event.canvasId, requireTargetId(event), metadata);
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
    case "connection.deleted":
      return restoreConnection(
        tx,
        event.canvasId,
        snapshotValue<ConnectionSnapshot | undefined>(metadata, "connection"),
      );
    case "entity.deleted":
      return restoreEntitySubtree(
        tx,
        event.canvasId,
        snapshotValue<Record<string, unknown>>(metadata, "snapshot") ?? {},
      );
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
  for (const id of linkIds) {
    const [stillUsed] = await tx
      .select({ id: canvasConnections.connectionId })
      .from(canvasConnections)
      .where(eq(canvasConnections.connectionId, id))
      .limit(1);
    if (!stillUsed) await tx.delete(connections).where(eq(connections.id, id));
  }
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
  const [stillUsed] = await tx
    .select({ id: canvasConnections.connectionId })
    .from(canvasConnections)
    .where(eq(canvasConnections.connectionId, connectionId))
    .limit(1);
  if (!stillUsed) await tx.delete(connections).where(eq(connections.id, connectionId));
  await touchCanvas(tx, canvasId);
  return true;
}

async function restoreConnection(
  tx: Transaction,
  canvasId: string,
  connection: ConnectionSnapshot | undefined,
): Promise<boolean> {
  if (!connection) return false;
  await tx.insert(connections).values(connection).onConflictDoNothing();
  await tx
    .insert(canvasConnections)
    .values({ canvasId, connectionId: connection.id, bend: connection.bend })
    .onConflictDoUpdate({
      target: [canvasConnections.canvasId, canvasConnections.connectionId],
      set: { bend: connection.bend },
    });
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
  if (entityRows.length) await tx.insert(entities).values(entityRows).onConflictDoNothing();
  if (connectionRows.length) {
    await tx
      .insert(connections)
      .values(connectionRows.map(({ bend: _bend, ...connection }) => connection))
      .onConflictDoNothing();
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
  await touchCanvas(tx, canvasId);
  return true;
}

async function undoConnectionUpdated(
  tx: Transaction,
  canvasId: string,
  connectionId: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
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
  const [current] = await tx.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  if (!current) return false;
  const next = {
    type: previousField<ConnectionType>(metadata, "type", current.type),
    label: previousField<string>(metadata, "label", current.label),
    description: previousNullableField(metadata, "description"),
    metadata: previousField<Record<string, unknown>>(metadata, "metadata", current.metadata),
  };
  if (
    current.type === next.type &&
    current.label === next.label &&
    current.description === next.description &&
    JSON.stringify(current.metadata ?? {}) === JSON.stringify(next.metadata ?? {})
  )
    return false;
  await tx.update(connections).set(next).where(eq(connections.id, connectionId));
  await touchCanvas(tx, canvasId);
  return true;
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
