import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { collabDocuments, connections, entities } from "@wooble/db";
import type { PreviousMetadataEntry } from "../canvas/event-metadata";
import { registerExternalMetadataKey, type Transaction } from "../canvas/undo-registry";

export type DocumentRef = { kind: "entity" | "connection"; id: string };
export const DOCUMENTATION_KEY = "documentation";
/** Top-level update-event key for legacy documentation undo state. */
export const DOCUMENTATION_UNDO_KEY = "documentationUndo";
/** Delete-event snapshot key, containing entries keyed by `${kind}:${id}`. */
export const DOCUMENTATION_SNAPSHOT_KEY = "documentation";
/** Transaction-local writer marker; only enabled around an owner UPDATE. */
export const DOCUMENTATION_WRITER_SETTING = "wooble.documentation_writer";

export class CollaborativeDocumentationConflict extends Error {
  readonly status = 409;

  constructor() {
    super("Collaborative documentation cannot be changed by a legacy write");
    this.name = "CollaborativeDocumentationConflict";
  }
}

export class DocumentWorkspaceMismatch extends Error {
  readonly status = 500;

  constructor(ref: DocumentRef, ownerWorkspaceId: string, documentWorkspaceId: string) {
    // The request error handler logs this error. Include reconciliation ids, never text.
    super(
      `Document workspace mismatch: ${ref.kind}:${ref.id}, owner workspace ${ownerWorkspaceId}, document workspace ${documentWorkspaceId}`,
    );
    this.name = "DocumentWorkspaceMismatch";
  }
}

const ownerTable = (ref: DocumentRef) => (ref.kind === "entity" ? entities : connections);
// PostgreSQL returns UUIDs in lowercase even when a caller supplied uppercase hex digits.
const documentKey = (ref: DocumentRef) => `${ref.kind}:${ref.id.toLowerCase()}`;

/** Owners are already locked (or newly inserted) by the caller; snapshots need only unlocked reads. */
async function readDocuments(tx: Transaction, refs: DocumentRef[], lock: boolean) {
  const owners = new Map<string, { workspaceId: string; previous: PreviousMetadataEntry }>();
  const conditions = [];
  for (const kind of ["entity", "connection"] as const) {
    const ids = [...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id))];
    if (!ids.length) continue;
    const table = ownerTable({ kind, id: "" });
    const rows = await tx
      .select({
        id: table.id,
        workspaceId: table.workspaceId,
        present: sql<boolean>`${table.metadata} ? ${DOCUMENTATION_KEY}`,
        value: sql<unknown>`${table.metadata} -> ${DOCUMENTATION_KEY}`,
      })
      .from(table)
      .where(sql`${table.id} = ANY(${sql.param(ids)}::uuid[])`);
    for (const row of rows) {
      owners.set(documentKey({ kind, id: row.id }), {
        workspaceId: row.workspaceId,
        previous: row.present ? { present: true, value: row.value } : { present: false },
      });
    }
    // Match both parts of the identity; the same UUID may occur in both owner tables.
    conditions.push(
      and(eq(collabDocuments.objectKind, kind), sql`${collabDocuments.objectId} = ANY(${sql.param(ids)}::uuid[])`),
    );
  }
  const documents = new Map<string, { bootstrapped: boolean; mirror: string | null }>();
  if (!conditions.length) return { owners, documents };
  const query = tx
    .select({
      kind: collabDocuments.objectKind,
      id: collabDocuments.objectId,
      workspaceId: collabDocuments.workspaceId,
      bootstrapped: sql<boolean>`${collabDocuments.state} IS NOT NULL AND ${collabDocuments.bootstrapVersion} IS NOT NULL`,
      mirror: collabDocuments.mirrorMarkdown,
    })
    .from(collabDocuments)
    .where(and(eq(collabDocuments.field, DOCUMENTATION_KEY), or(...conditions)))
    .orderBy(asc(collabDocuments.objectKind), asc(collabDocuments.objectId));
  for (const document of await (lock ? query.for("update") : query)) {
    const key = documentKey(document);
    const owner = owners.get(key);
    // Missing owners are skipped, including their retained/tombstoned collab rows.
    if (!owner) continue;
    if (document.workspaceId !== owner.workspaceId) {
      throw new DocumentWorkspaceMismatch(document, owner.workspaceId, document.workspaceId);
    }
    documents.set(key, document);
  }
  return { owners, documents };
}

/** The caller already holds canvas locks, then the owner FOR UPDATE (or has inserted it). */
async function readDocument(tx: Transaction, ref: DocumentRef, lock: boolean) {
  const table = ownerTable(ref);
  const [owner] = await tx
    .select({
      workspaceId: table.workspaceId,
      present: sql<boolean>`${table.metadata} ? ${DOCUMENTATION_KEY}`,
      value: sql<unknown>`${table.metadata} -> ${DOCUMENTATION_KEY}`,
    })
    .from(table)
    .where(eq(table.id, ref.id));
  if (!owner) return undefined;

  const query = tx
    .select({
      workspaceId: collabDocuments.workspaceId,
      bootstrapped: sql<boolean>`${collabDocuments.state} IS NOT NULL AND ${collabDocuments.bootstrapVersion} IS NOT NULL`,
      mirror: collabDocuments.mirrorMarkdown,
    })
    .from(collabDocuments)
    .where(
      and(
        eq(collabDocuments.objectKind, ref.kind),
        eq(collabDocuments.objectId, ref.id),
        eq(collabDocuments.field, DOCUMENTATION_KEY),
      ),
    );
  const [document] = await (lock ? query.for("update") : query);
  if (document && document.workspaceId !== owner.workspaceId) {
    throw new DocumentWorkspaceMismatch(ref, owner.workspaceId, document.workspaceId);
  }
  const previous: PreviousMetadataEntry = owner.present ? { present: true, value: owner.value } : { present: false };
  return { previous, document };
}

async function applyEntry(
  tx: Transaction,
  ref: DocumentRef,
  previous: PreviousMetadataEntry,
  entry: PreviousMetadataEntry,
): Promise<boolean> {
  if (isDeepStrictEqual(previous, entry)) return false;
  await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'on', true)`);
  await updateEntry(tx, ref, entry);
  // Reset only on success: an aborted transaction discards the local setting, and a reset would mask its error.
  await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'off', true)`);
  return true;
}

async function updateEntry(tx: Transaction, ref: DocumentRef, entry: PreviousMetadataEntry): Promise<void> {
  const table = ownerTable(ref);
  const metadata = entry.present
    ? sql`${table.metadata} || jsonb_build_object(${DOCUMENTATION_KEY}::text, ${JSON.stringify(entry.value)}::jsonb)`
    : sql`${table.metadata} - ${DOCUMENTATION_KEY}`;

  // Target only this key: callers may already have changed other metadata in this transaction.
  await tx.update(table).set({ metadata }).where(eq(table.id, ref.id));
}

function mirrorEntry(mirror: string | null): PreviousMetadataEntry {
  // The schema requires a non-null mirror whenever state is present.
  if (mirror === null) throw new Error("Bootstrapped document has no mirror");
  return mirror === "" ? { present: false } : { present: true, value: mirror };
}

/** Legacy PATCH/create write; requires sorted canvas locks followed by the owner lock. */
export async function writeDocumentation(
  tx: Transaction,
  ref: DocumentRef,
  value: string | null,
): Promise<{ previous: PreviousMetadataEntry; changed: boolean }> {
  const current = await readDocument(tx, ref, true);
  if (!current) throw new Error(`Documentation owner not found: ${ref.kind}:${ref.id}`);
  if (current.document?.bootstrapped) throw new CollaborativeDocumentationConflict();
  const entry: PreviousMetadataEntry = value === null || value === "" ? { present: false } : { present: true, value };
  return { previous: current.previous, changed: await applyEntry(tx, ref, current.previous, entry) };
}

/**
 * Whether restoreDocumentation(tx, ref, entry) would write. Plain unlocked read (safe for the undo walk; no share-class lock).
 * Bootstrapped → owner projection differs from the mirror (entry ignored). Not bootstrapped → entry defined and differs from the owner's current state.
 * Owner missing → false.
 */
export async function documentationRestoreWouldChange(
  tx: Transaction,
  ref: DocumentRef,
  entry: PreviousMetadataEntry | undefined,
): Promise<boolean> {
  const current = await readDocument(tx, ref, false);
  if (!current) return false;
  const target = current.document?.bootstrapped ? mirrorEntry(current.document.mirror) : entry;
  return target !== undefined && !isDeepStrictEqual(current.previous, target);
}

/** Undo/restore under the same locks; collaborative text always comes from its mirror. */
export async function restoreDocumentation(
  tx: Transaction,
  ref: DocumentRef,
  entry: PreviousMetadataEntry | undefined,
): Promise<boolean> {
  return restoreDocumentationBatch(tx, [{ ref, entry }]);
}

/** Restore all owners under the caller's canvas/owner locks, then sorted collab row locks. */
export async function restoreDocumentations(
  tx: Transaction,
  items: Array<{ ref: DocumentRef; entry: PreviousMetadataEntry | undefined }>,
): Promise<void> {
  await restoreDocumentationBatch(tx, items);
}

// Both public APIs share this implementation; the single-item API also reports whether it changed.
async function restoreDocumentationBatch(
  tx: Transaction,
  items: Array<{ ref: DocumentRef; entry: PreviousMetadataEntry | undefined }>,
): Promise<boolean> {
  const { owners, documents } = await readDocuments(
    tx,
    items.map((item) => item.ref),
    true,
  );
  const updates: Array<{ ref: DocumentRef; entry: PreviousMetadataEntry }> = [];
  for (const { ref, entry } of items) {
    const key = documentKey(ref);
    const owner = owners.get(key);
    if (!owner) continue;
    const document = documents.get(key);
    const target = document?.bootstrapped ? mirrorEntry(document.mirror) : entry;
    if (target === undefined || isDeepStrictEqual(owner.previous, target)) continue;
    updates.push({ ref, entry: target });
    // Preserve sequential semantics if an owner occurs more than once in the batch.
    owner.previous = target;
  }
  if (!updates.length) return false;
  await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'on', true)`);
  for (const { ref, entry } of updates) await updateEntry(tx, ref, entry);
  // As above, resetting after a failed UPDATE would hide the original database error.
  await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'off', true)`);
  return true;
}

/** Re-project a bootstrapped mirror under the caller's canvas and owner locks. */
export async function reprojectMirror(tx: Transaction, ref: DocumentRef): Promise<boolean> {
  const current = await readDocument(tx, ref, true);
  if (!current?.document?.bootstrapped) return false;
  return applyEntry(tx, ref, current.previous, mirrorEntry(current.document.mirror));
}

/** Read under the caller's locks; optionally lock the collab row FOR UPDATE. */
export async function isBootstrapped(tx: Transaction, ref: DocumentRef, lock = false): Promise<boolean> {
  return (await readDocument(tx, ref, lock))?.document?.bootstrapped ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is PreviousMetadataEntry {
  return isRecord(value) && (value.present === false || (value.present === true && Object.hasOwn(value, "value")));
}

/** Read newest-format undo state first, with compatibility for both historical formats. */
export function documentationUndoEntry(eventMetadata: Record<string, unknown>): PreviousMetadataEntry | undefined {
  const entry = eventMetadata[DOCUMENTATION_UNDO_KEY];
  if (isEntry(entry)) return entry;
  const previousMetadata = eventMetadata.previousMetadata;
  if (isRecord(previousMetadata) && isEntry(previousMetadata[DOCUMENTATION_KEY])) {
    return previousMetadata[DOCUMENTATION_KEY];
  }
  // A v2 event without this key did not touch documentation. Its `previous` is not a full snapshot.
  if (eventMetadata.version === 2) return undefined;
  const previous = eventMetadata.previous;
  if (!isRecord(previous) || !isRecord(previous.metadata)) return undefined;
  return Object.hasOwn(previous.metadata, DOCUMENTATION_KEY)
    ? { present: true, value: previous.metadata[DOCUMENTATION_KEY] }
    : { present: false };
}

/** Capture only legacy owners that have documentation, without copying collaborative text into history. */
export async function snapshotDocumentation(
  tx: Transaction,
  refs: DocumentRef[],
): Promise<Record<string, PreviousMetadataEntry>> {
  const snapshot: Record<string, PreviousMetadataEntry> = {};
  const { owners, documents } = await readDocuments(tx, refs, false);
  for (const ref of refs) {
    const key = documentKey(ref);
    const owner = owners.get(key);
    if (owner?.previous.present && !documents.get(key)?.bootstrapped) {
      snapshot[`${ref.kind}:${ref.id}`] = owner.previous;
    }
  }
  return snapshot;
}

/** Copy metadata while leaving documentation ownership to this module. */
export function withoutDocumentation<T extends Record<string, unknown>>(metadata: T): T {
  const copy = { ...metadata };
  delete copy[DOCUMENTATION_KEY];
  return copy;
}

/** Called at cutover by app startup, once undo has been adapted to this module. */
export function registerCollabDocumentation(): () => void {
  return registerExternalMetadataKey(DOCUMENTATION_KEY);
}
