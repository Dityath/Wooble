import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
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
  const table = ownerTable(ref);
  const metadata = entry.present
    ? sql`${table.metadata} || jsonb_build_object(${DOCUMENTATION_KEY}::text, ${JSON.stringify(entry.value)}::jsonb)`
    : sql`${table.metadata} - ${DOCUMENTATION_KEY}`;

  await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'on', true)`);
  try {
    // Target only this key: callers may already have changed other metadata in this transaction.
    await tx.update(table).set({ metadata }).where(eq(table.id, ref.id));
  } finally {
    await tx.execute(sql`SELECT set_config(${DOCUMENTATION_WRITER_SETTING}, 'off', true)`);
  }
  return true;
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
  const current = await readDocument(tx, ref, true);
  if (!current) return false;
  if (current.document?.bootstrapped) {
    return applyEntry(tx, ref, current.previous, mirrorEntry(current.document.mirror));
  }
  return entry === undefined ? false : applyEntry(tx, ref, current.previous, entry);
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
  for (const ref of refs) {
    const current = await readDocument(tx, ref, false);
    if (current && !current.document?.bootstrapped && current.previous.present) {
      snapshot[`${ref.kind}:${ref.id}`] = current.previous;
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
