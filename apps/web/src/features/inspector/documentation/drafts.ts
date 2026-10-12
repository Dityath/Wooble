/**
 * Documentation that could not be saved, kept in this browser so it can be restored when the documentation is opened
 * again. Drafts are keyed by user and object, so another account on the same device never sees them, and signing out
 * removes them all. Storage can be unavailable or full, so every access is guarded and a draft is only ever a fallback.
 */
const DRAFT_PREFIX = "wooble:documentation-draft:";

export interface DocumentationDraft {
  /** The unsaved documentation, trimmed as it would be saved. */
  markdown: string;
  /** The saved documentation the draft was edited from, to tell whether it changed since. */
  base: string;
  /** When the draft was kept, as an ISO timestamp. */
  keptAt: string;
}

export function documentationDraftKey(userId: string, kind: "entity" | "connection", id: string) {
  return `${DRAFT_PREFIX}${userId}:${kind}:${id}`;
}

export function readDocumentationDraft(key: string): DocumentationDraft | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") return undefined;
    const { markdown, base, keptAt } = stored as Record<string, unknown>;
    if (typeof markdown !== "string" || typeof base !== "string" || typeof keptAt !== "string") return undefined;
    return { markdown, base, keptAt };
  } catch {
    return undefined;
  }
}

/** Keeps `draft` under `key`, and returns whether it was kept. */
export function keepDocumentationDraft(key: string, draft: DocumentationDraft): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function removeDocumentationDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing can be removed from storage that cannot be used.
  }
}

/** Removes every user's documentation drafts from this browser, such as when signing out. */
export function clearDocumentationDrafts() {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) if (key?.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
  } catch {
    // Storage that cannot be read holds no drafts this app could show.
  }
}
