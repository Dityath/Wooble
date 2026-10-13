/**
 * Recoverable copies of unsaved documentation Markdown, kept in `localStorage` so a reload, a crashed tab, or a
 * rejected save cannot silently destroy what someone wrote. Nothing here talks to React or to the editor: later cards
 * decide when to write a draft and when to offer to recover one.
 */

/** Objects that carry documentation. Entities and connections share `metadata.documentation` but not ids. */
export type DraftObjectKind = "entity" | "connection";

export interface DocumentationDraft {
  /** The Markdown the user had not saved yet. May be longer than the 20,000 character server limit. */
  markdown: string;
  /** Epoch milliseconds of the last write, used for the recovery prompt's wording and for expiry. */
  savedAt: number;
}

/** Versioned prefix, so a future change to the stored shape can migrate instead of misreading old entries. */
const NAMESPACE = "wooble:draft:v1";
/** A week is long enough to recover a forgotten draft and short enough that a stale copy cannot resurface in an editor. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The key one draft lives under. Each segment is encoded because ids are opaque strings: an id containing `:` or `/`
 * would otherwise forge the key of another user, kind, or object.
 */
export function draftKey(userId: string, kind: DraftObjectKind, objectId: string): string {
  return `${NAMESPACE}:${[userId, kind, objectId].map(encodeURIComponent).join(":")}`;
}

/**
 * The stored draft, or `null` when it is absent, unreadable, or older than the retention window. Anything unrecognised
 * is treated as absent rather than as an error: a draft is a convenience, and a corrupt entry must never break an
 * editor. Never throws, because `localStorage` access itself throws in Safari's private mode.
 */
export function readDraft(userId: string, kind: DraftObjectKind, objectId: string): DocumentationDraft | null {
  // The session is an HttpOnly cookie with no auth context above this module, so without a known user there is no way
  // to tell whose draft this is. Reading is refused rather than guessing: a signed-out visitor shares the browser with
  // whoever used it last.
  if (!userId) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(draftKey(userId, kind, objectId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof stored !== "object" || stored === null) return null;
  const { markdown, savedAt } = stored as { markdown?: unknown; savedAt?: unknown };
  if (typeof markdown !== "string" || typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (Date.now() - savedAt > RETENTION_MS) return null;
  return { markdown, savedAt };
}

/**
 * Stores the draft for one object. Blank text removes the entry instead: an empty draft has nothing to recover, and
 * keeping it would offer to restore nothing. Over-limit text is stored as given, since text the server would reject is
 * exactly the text that must not be lost. Never throws; a full or blocked store only costs the draft.
 */
export function writeDraft(userId: string, kind: DraftObjectKind, objectId: string, markdown: string): void {
  if (!userId) return;
  try {
    const key = draftKey(userId, kind, objectId);
    if (markdown.trim() === "") localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ markdown, savedAt: Date.now() } satisfies DocumentationDraft));
  } catch {
    // QuotaExceededError, or a store Safari refuses to touch at all. The editor keeps its text either way.
  }
}

/** Removes one object's draft, as after that documentation was saved successfully. Never throws. */
export function clearDraft(userId: string, kind: DraftObjectKind, objectId: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(draftKey(userId, kind, objectId));
  } catch {
    // A store that refuses removal has nothing to lose.
  }
}

/**
 * Removes every documentation draft, for every user, on sign-out and on a password change. Only this module's own
 * keys are touched: another sign-in on a shared browser must not read the previous user's drafts, but the rest of the
 * app's storage (the theme, for one) is none of this module's business.
 */
export function clearAllDocumentationDrafts(): void {
  try {
    const prefix = `${NAMESPACE}:`;
    // Backwards, because removing an entry shifts the indexes of the ones after it.
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Nothing else on the page depends on this, so a failing store is left alone.
  }
}
