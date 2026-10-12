import { CircleAlert, History } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { DocumentationEditor, type DocumentationEditorHandle } from "./documentation/documentation-editor";
import {
  type DocumentationDraft,
  keepDocumentationDraft,
  readDocumentationDraft,
  removeDocumentationDraft,
} from "./documentation/drafts";

const AUTOSAVE_DELAY_MS = 900;
// Mirrors `documentation: z.string().trim().max(20000)` in the API contracts, which do not export the limit.
const MAX_DOCUMENTATION_LENGTH = 20_000;
// The error for documentation that is too long to send. Its message says by how much, so it is written when shown.
const TOO_LONG = "too-long";

/** Describes how far `length` characters of Markdown are over the limit. */
function overLimitMessage(length: number) {
  const over = length - MAX_DOCUMENTATION_LENGTH;
  return `Documentation is limited to 20,000 characters of Markdown. This is ${over.toLocaleString("en-US")} ${over === 1 ? "character" : "characters"} over; shorten it to save.`;
}

/** When a draft was kept, in the viewer's locale. */
function keptAtLabel(keptAt: string) {
  const date = new Date(keptAt);
  return Number.isNaN(date.getTime())
    ? "earlier"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface RichDocumentationProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  /**
   * Where this documentation's unsaved changes are kept in this browser when the editor closes before they are saved,
   * from `documentationDraftKey`. Without it, nothing is kept.
   */
  draftKey?: string;
}

/**
 * Documentation that is always editable and saves itself: 900 ms after the last edit, when the editor loses focus, and
 * when it closes. Saves run one at a time. Changes that are not saved by the time it closes are kept in this browser
 * (see `drafts.ts`) and offered again the next time the documentation opens.
 *
 * Markdown is compared and saved trimmed, because the API trims what it stores. Trimming also ignores the blank lines
 * the editor writes around a table and after the empty paragraph it keeps at the end of the document. Edits are
 * compared with the Markdown the editor writes for the loaded documentation, never with `value`, because the editor
 * writes equivalent syntax in one canonical form. Opening or leaving documentation without an edit never saves it.
 */
export function RichDocumentation({ value, onSave, draftKey }: RichDocumentationProps) {
  const editor = useRef<DocumentationEditorHandle>(null);
  const save = useRef(onSave);
  const keepAt = useRef(draftKey);
  useLayoutEffect(() => {
    save.current = onSave;
    keepAt.current = draftKey;
  });
  // Trimmed Markdown: the editor's document after its latest change, the document as last loaded or saved, and the
  // document most recently queued for saving. The latest document is kept here because the editor may already be
  // destroyed when unmounting saves it.
  const latest = useRef("");
  const lastSaved = useRef("");
  const lastSubmitted = useRef("");
  // The `value` the editor last loaded, and a newer one it has not shown yet because the user was in the editor.
  const loaded = useRef(value);
  const pending = useRef<string | undefined>(undefined);
  const edited = useRef(false);
  // The documentation as the API last returned or saved it, trimmed: what a draft kept on close was edited from.
  const persisted = useRef(value.trim());
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // The latest document once the user has edited it; undefined before the first edit.
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState("");
  const [savesInFlight, setSavesInFlight] = useState(0);
  const [error, setError] = useState("");
  // A draft an earlier editor kept for this documentation, which the user can restore or discard.
  const [kept, setKept] = useState<DocumentationDraft>();
  // Set once a save is forbidden: the user may not edit this documentation, so nothing more is sent or kept.
  const [readOnly, setReadOnly] = useState(false);
  const forbidden = useRef(false);

  /**
   * Shows documentation that changed elsewhere, unless the user is working on it: the editor has focus, unsaved changes,
   * or a save in progress. Returns whether it was shown.
   */
  const show = useCallback((next: string) => {
    const handle = editor.current;
    if (!handle || handle.hasFocus() || latest.current !== lastSaved.current) return false;
    const replaced = handle.replace(next).trim();
    loaded.current = next;
    persisted.current = next.trim();
    pending.current = undefined;
    latest.current = replaced;
    lastSaved.current = replaced;
    lastSubmitted.current = replaced;
    setSaved(replaced);
    setDraft((current) => (current === undefined ? undefined : replaced));
    return true;
  }, []);

  const commit = useCallback(
    (next: string) => {
      if (forbidden.current) return;
      if (next === lastSubmitted.current) {
        // Nothing new to save, and a document that matches the saved one has no failed save to report.
        if (next === lastSaved.current) setError("");
        return;
      }
      if (next.length > MAX_DOCUMENTATION_LENGTH) {
        setError(TOO_LONG);
        return;
      }
      lastSubmitted.current = next;
      // This save replaces documentation that changed elsewhere in the meantime (the last write wins).
      pending.current = undefined;
      setSavesInFlight((count) => count + 1);
      setError("");
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          await save.current(next);
          lastSaved.current = next;
          persisted.current = next;
          setSaved(next);
          setError("");
          // The draft kept when the editor closed has been saved, even if the editor is gone by now.
          const key = keepAt.current;
          if (key && readDocumentationDraft(key)?.markdown === next) removeDocumentationDraft(key);
          // An update that arrived during the save, while the user was not in the editor, was held back only because the
          // save was in progress.
          if (pending.current !== undefined) show(pending.current);
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 403) {
            // Retrying cannot help, and changes the user may not save are never offered again, even once the editor
            // has closed.
            forbidden.current = true;
            setReadOnly(true);
            setError("");
            if (keepAt.current) removeDocumentationDraft(keepAt.current);
            return;
          }
          // Submit it again on the next attempt, unless a newer document is already queued.
          if (lastSubmitted.current === next) lastSubmitted.current = lastSaved.current;
          setError(cause instanceof Error ? cause.message : "Could not save documentation");
        } finally {
          setSavesInFlight((count) => count - 1);
        }
      });
    },
    [show],
  );

  const handleChange = useCallback((markdown: string) => {
    const next = markdown.trim();
    latest.current = next;
    // The editor can change its document without an edit, such as adding an empty paragraph after a final table or
    // code block when it is first focused. That writes the same trimmed Markdown, so it is not an edit.
    if (!edited.current && next === lastSaved.current) return;
    edited.current = true;
    // The user's edit replaces documentation that changed elsewhere and was not shown (the last write wins).
    pending.current = undefined;
    setDraft(next);
    if (next.length <= MAX_DOCUMENTATION_LENGTH) setError((current) => (current === TOO_LONG ? "" : current));
  }, []);

  const handleBlur = useCallback(() => {
    commit(latest.current);
    // An update that arrived while the user was only reading the documentation is shown once they leave it.
    if (pending.current !== undefined) show(pending.current);
  }, [commit, show]);

  useEffect(() => {
    const loadedMarkdown = editor.current?.getMarkdown().trim() ?? "";
    latest.current = loadedMarkdown;
    lastSaved.current = loadedMarkdown;
    lastSubmitted.current = loadedMarkdown;
    setSaved(loadedMarkdown);
    // Closing the editor before the autosave saves the pending edit. Unsaved documentation is also kept in this
    // browser until it saves, because the save can fail once nothing is left to report it, documentation over the
    // limit is not sent at all, and a save in flight can still fail. Under StrictMode's extra unmount nothing has
    // changed, so nothing is kept or saved.
    return () => {
      const key = keepAt.current;
      if (key && !forbidden.current && latest.current !== lastSaved.current)
        keepDocumentationDraft(key, {
          markdown: latest.current,
          base: persisted.current,
          keptAt: new Date().toISOString(),
        });
      commit(latest.current);
    };
  }, [commit]);

  // Offers a draft kept by an earlier editor, unless it is already the saved documentation.
  useEffect(() => {
    if (!draftKey) return;
    const earlier = readDocumentationDraft(draftKey);
    if (!earlier) return;
    if (earlier.markdown === persisted.current || earlier.markdown === lastSaved.current) {
      removeDocumentationDraft(draftKey);
      return;
    }
    setKept(earlier);
  }, [draftKey]);

  // The kept draft's own save, finishing after it was offered, makes it the saved documentation.
  useEffect(() => {
    if (!kept || value.trim() !== kept.markdown) return;
    setKept(undefined);
    if (keepAt.current) removeDocumentationDraft(keepAt.current);
  }, [kept, value]);

  const restoreKept = () => {
    const handle = editor.current;
    if (!handle || !kept) return;
    const restored = handle.replace(kept.markdown).trim();
    // The restored draft is an unsaved edit now, which is kept again if the editor closes before it saves.
    if (draftKey) removeDocumentationDraft(draftKey);
    setKept(undefined);
    latest.current = restored;
    edited.current = true;
    pending.current = undefined;
    setDraft(restored);
    commit(restored);
  };

  const discardKept = () => {
    if (draftKey) removeDocumentationDraft(draftKey);
    setKept(undefined);
  };

  useEffect(() => {
    if (draft === undefined) return;
    const timer = setTimeout(() => commit(draft), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, commit]);

  // Documentation changed elsewhere replaces the editor's document only while the user is not working on it. An update
  // that arrives while the editor has focus is shown when the user leaves it without an edit. Otherwise the editor keeps
  // its document, and the next save writes over the update.
  useEffect(() => {
    if (value === loaded.current) {
      // Changed back to the documentation the editor shows, such as by an undo elsewhere: nothing is left to show.
      pending.current = undefined;
      return;
    }
    const incoming = value.trim();
    // This editor's own save coming back, possibly before the save has finished.
    if (incoming === lastSaved.current || incoming === lastSubmitted.current) {
      loaded.current = value;
      persisted.current = incoming;
      pending.current = undefined;
      return;
    }
    if (!show(value)) pending.current = value;
  }, [value, show]);

  // The dot's colour and the text a screen reader reads come from one value, so they cannot disagree. Documentation that
  // is too long has not been sent and so is only unsaved; a failed save is what the error state is for.
  const saveState = readOnly
    ? { state: "error", label: "Not saved" }
    : draft === undefined
      ? undefined
      : error && error !== TOO_LONG
        ? { state: "error", label: "Save failed" }
        : savesInFlight > 0
          ? { state: "saving", label: "Saving…" }
          : draft !== saved
            ? { state: "unsaved", label: "Unsaved changes" }
            : { state: "saved", label: "Saved" };
  return (
    <section className="documentation-card" aria-label="Documentation">
      <DocumentationEditor
        ref={editor}
        initialMarkdown={value}
        onChange={handleChange}
        onBlur={handleBlur}
        readOnly={readOnly}
        status={
          // The live region stays mounted while there is nothing to report, so the first save is announced too.
          <span className="documentation-save-state" data-state={saveState?.state} role="status">
            {saveState?.label ?? ""}
          </span>
        }
        notice={
          <>
            {readOnly && (
              <p className="documentation-notice is-error" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>
                  You don't have permission to edit this documentation, so these changes were not saved. Copy anything
                  you want to keep, then ask a workspace manager for edit access.
                </span>
              </p>
            )}
            {kept && !readOnly && (
              <p className="documentation-notice" role="alert">
                <History size={15} aria-hidden="true" />
                <span>
                  Unsaved changes to this documentation from {keptAtLabel(kept.keptAt)} were kept in this browser.
                  {kept.base !== value.trim() && " It has changed since, and restoring them replaces those changes."}
                </span>
                <button type="button" onClick={restoreKept}>
                  Restore
                </button>
                <button type="button" onClick={discardKept}>
                  Discard
                </button>
              </p>
            )}
            {error === TOO_LONG ? (
              // Retrying cannot help until the documentation is shorter, so the notice says by how much instead.
              <p className="documentation-notice is-error" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>{overLimitMessage(draft?.length ?? 0)}</span>
              </p>
            ) : (
              error && (
                <p className="documentation-notice is-error" role="alert">
                  <CircleAlert size={15} aria-hidden="true" />
                  <span>{error}</span>
                  <button type="button" onClick={() => commit(latest.current)}>
                    Retry
                  </button>
                </p>
              )
            )}
          </>
        }
      />
    </section>
  );
}
