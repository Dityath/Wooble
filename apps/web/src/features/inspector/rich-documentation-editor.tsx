import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DocumentationEditor, type DocumentationEditorHandle } from "./documentation/documentation-editor";

const AUTOSAVE_DELAY_MS = 900;
// Mirrors `documentation: z.string().trim().max(20000)` in the API contracts, which do not export the limit.
const MAX_DOCUMENTATION_LENGTH = 20_000;
const TOO_LONG_MESSAGE = "Documentation is limited to 20,000 characters of Markdown. Shorten it to save.";

/**
 * Documentation that is always editable and saves itself: 900 ms after the last edit, when the editor loses focus, and
 * when it closes. Saves run one at a time.
 *
 * Markdown is compared and saved trimmed, because the API trims what it stores. Trimming also ignores the blank lines
 * the editor writes around a table and after the empty paragraph it keeps at the end of the document. Edits are
 * compared with the Markdown the editor writes for the loaded documentation, never with `value`, because the editor
 * writes equivalent syntax in one canonical form. Opening or leaving documentation without an edit never saves it.
 */
export function RichDocumentation({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  const editor = useRef<DocumentationEditorHandle>(null);
  const save = useRef(onSave);
  useLayoutEffect(() => {
    save.current = onSave;
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
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // The latest document once the user has edited it; undefined before the first edit.
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState("");
  const [savesInFlight, setSavesInFlight] = useState(0);
  const [error, setError] = useState("");

  const commit = useCallback((next: string) => {
    if (next === lastSubmitted.current) {
      // Nothing new to save, and a document that matches the saved one has no failed save to report.
      if (next === lastSaved.current) setError("");
      return;
    }
    if (next.length > MAX_DOCUMENTATION_LENGTH) {
      setError(TOO_LONG_MESSAGE);
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
        setSaved(next);
        setError("");
      } catch (cause) {
        // Submit it again on the next attempt, unless a newer document is already queued.
        if (lastSubmitted.current === next) lastSubmitted.current = lastSaved.current;
        setError(cause instanceof Error ? cause.message : "Could not save documentation");
      } finally {
        setSavesInFlight((count) => count - 1);
      }
    });
  }, []);

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
    if (next.length <= MAX_DOCUMENTATION_LENGTH) setError((current) => (current === TOO_LONG_MESSAGE ? "" : current));
  }, []);

  /**
   * Shows documentation that changed elsewhere, unless the user is working on it: the editor has focus, unsaved changes,
   * or a save in progress. Returns whether it was shown.
   */
  const show = useCallback((next: string) => {
    const handle = editor.current;
    if (!handle || handle.hasFocus() || latest.current !== lastSaved.current) return false;
    const replaced = handle.replace(next).trim();
    loaded.current = next;
    pending.current = undefined;
    latest.current = replaced;
    lastSaved.current = replaced;
    lastSubmitted.current = replaced;
    setSaved(replaced);
    setDraft((current) => (current === undefined ? undefined : replaced));
    return true;
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
    // Closing the editor before the autosave saves the pending edit. Under StrictMode's extra unmount nothing has
    // changed, so nothing is saved.
    return () => commit(latest.current);
  }, [commit]);

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
      pending.current = undefined;
      return;
    }
    if (!show(value)) pending.current = value;
  }, [value, show]);

  // The dot's colour and the text a screen reader reads come from one value, so they cannot disagree. Documentation that
  // is too long has not been sent and so is only unsaved; a failed save is what the error state is for.
  const saveState =
    draft === undefined
      ? undefined
      : error && error !== TOO_LONG_MESSAGE
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
        status={
          // The live region stays mounted while there is nothing to report, so the first save is announced too.
          <span className="documentation-save-state" data-state={saveState?.state} role="status">
            {saveState?.label ?? ""}
          </span>
        }
        notice={
          error && (
            <p className="documentation-notice is-error" role="alert">
              <CircleAlert size={15} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" onClick={() => commit(latest.current)}>
                Retry
              </button>
            </p>
          )
        }
      />
    </section>
  );
}
