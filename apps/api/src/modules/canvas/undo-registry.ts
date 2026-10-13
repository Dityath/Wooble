import type { CanvasEventAction, db } from "@wooble/db";

/** Database transaction handed to undo hooks. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a delete event removed: entity ids or connection ids. */
export interface DeleteUndoTarget {
  kind: "entity" | "connection";
  ids: string[];
}

/**
 * Lets another subsystem (comments, collaboration, ...) save its own data when
 * an entity or connection is deleted and put it back when the delete is undone.
 *
 * - `snapshot` runs inside the delete transaction, before the rows are deleted.
 *   Returning `undefined` stores nothing; anything else must be JSON-serialisable.
 *   It is stored under event metadata `hooks` (keyed by hook name) and is never
 *   exposed by the activity feed.
 * - `restore` runs inside the undo transaction, after the graph rows are
 *   restored, and receives exactly what `snapshot` returned. It must be
 *   idempotent; if it throws, the whole undo is rolled back.
 * - `target.ids` for an entity delete include the deleted subtree.
 *
 * Registrations are process-local: register at startup on every instance, or
 * an instance without the hook silently skips capture and restore. Namespace
 * external metadata keys (for example "comments.threadIds"). Registering a hook
 * with an existing name replaces the earlier one.
 */
export interface DeleteUndoHook {
  name: string;
  snapshot(tx: Transaction, target: DeleteUndoTarget): Promise<unknown>;
  restore(tx: Transaction, target: DeleteUndoTarget, data: unknown): Promise<void>;
}

// canvas.undo entries are historical records, never reversible themselves.
const DEFAULT_NON_REVERSIBLE: CanvasEventAction[] = ["canvas.undo"];
const nonReversibleActions = new Set<CanvasEventAction>(DEFAULT_NON_REVERSIBLE);
const externalMetadataKeys = new Set<string>();
const deleteHooks = new Map<string, DeleteUndoHook>();

/**
 * Marks an action as never undoable. Undo walks past such events without
 * marking them undone. Returns a function that removes the registration
 * (the default `canvas.undo` entry cannot be removed).
 */
export function registerNonReversibleAction(action: CanvasEventAction): () => void {
  const added = !nonReversibleActions.has(action);
  nonReversibleActions.add(action);
  return () => {
    if (added) nonReversibleActions.delete(action);
  };
}

/** Actions that are never undo candidates. */
export function listNonReversibleActions(): CanvasEventAction[] {
  return [...nonReversibleActions];
}

/**
 * Declares a metadata key owned by another subsystem. Undo never restores or
 * deletes it and it never counts toward undo conflicts. Returns an unregister function.
 */
export function registerExternalMetadataKey(key: string): () => void {
  const added = !externalMetadataKeys.has(key);
  externalMetadataKeys.add(key);
  return () => {
    if (added) externalMetadataKeys.delete(key);
  };
}

/** Whether a metadata key is owned by another subsystem. */
export function isExternalMetadataKey(key: string): boolean {
  return externalMetadataKeys.has(key);
}

/**
 * Registers a delete snapshot/restore hook, replacing any hook with the same
 * name. Returns an unregister function that only removes this registration.
 */
export function registerDeleteUndoHook(hook: DeleteUndoHook): () => void {
  deleteHooks.set(hook.name, hook);
  return () => {
    if (deleteHooks.get(hook.name) === hook) deleteHooks.delete(hook.name);
  };
}

/**
 * Runs every registered hook's `snapshot`. Returns a record keyed by hook name;
 * `{}` when there are no hooks or all returned `undefined`. Writers store it
 * under event metadata key `hooks`.
 */
export async function captureDeleteHooks(tx: Transaction, target: DeleteUndoTarget): Promise<Record<string, unknown>> {
  const captured: Record<string, unknown> = {};
  for (const hook of [...deleteHooks.values()]) {
    const data = await hook.snapshot(tx, target);
    if (data !== undefined) captured[hook.name] = data;
  }
  return captured;
}

/**
 * Hands each captured entry back to the hook of the same name. No-op for
 * undefined or empty input; entries for unknown hook names are ignored.
 */
export async function restoreDeleteHooks(tx: Transaction, target: DeleteUndoTarget, captured: unknown): Promise<void> {
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) return;
  for (const [name, data] of Object.entries(captured as Record<string, unknown>)) {
    const hook = deleteHooks.get(name);
    if (hook) await hook.restore(tx, target, data);
  }
}
