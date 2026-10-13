import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DocumentationEditor, type DocumentationEditorHandle } from "./documentation/documentation-editor";
import {
  clearDraft,
  type DocumentationDraft,
  type DraftObjectKind,
  readDraft,
  writeDraft,
} from "./documentation/drafts";
import { MarkdownContent } from "./documentation/markdown-content";
import { classifySaveError, type SaveFailure, tooLongMessage } from "./documentation/save-errors";

const AUTOSAVE_DELAY_MS = 900;
// Mirrors `documentation: z.string().trim().max(20000)` in the API contracts, which do not export the limit.
const MAX_DOCUMENTATION_LENGTH = 20_000;

export interface RichDocumentationProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  /**
   * Where this object's unsaved draft lives. The container passes it ONLY after `me` has resolved and the current
   * canvas access allows editing; while it is undefined, no draft is read, written, offered or restored.
   */
  draft?: { userId: string; kind: DraftObjectKind; objectId: string };
  /** Called whenever "has content that is not safely saved" changes (unsaved, in flight, failed, over limit). */
  onUnsavedChange?: (unsaved: boolean) => void;
}

function describeAge(savedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - savedAt) / 60_000));
  if (minutes < 1) return "a moment ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Documentation that is always editable and saves itself: 900 ms after the last edit, when the editor loses focus, and
 * when it closes. Saves run one at a time.
 *
 * Markdown is compared and saved trimmed, because the API trims what it stores. Trimming also ignores the blank lines
 * the editor writes around a table and after the empty paragraph it keeps at the end of the document. Edits are
 * compared with the Markdown the editor writes for the loaded documentation, never with `value`, because the editor
 * writes equivalent syntax in one canonical form. Opening or leaving documentation without an edit never saves it.
 *
 * With `draft`, every unsaved edit is also kept in local storage until a save succeeds, so a reload, a crash or a
 * rejected save does not lose it. A failed save is handled by its status: a 403 ends editing, other rejections do not
 * offer a pointless retry, and network or server failures can be retried.
 */
export function RichDocumentation({ value, onSave, draft: location, onUnsavedChange }: RichDocumentationProps) {
  const editor = useRef<DocumentationEditorHandle>(null);
  const save = useRef(onSave);
  const locationRef = useRef(location);
  const currentValue = useRef(value);
  const reportUnsaved = useRef(onUnsavedChange);
  useLayoutEffect(() => {
    save.current = onSave;
    locationRef.current = location;
    currentValue.current = value;
    reportUnsaved.current = onUnsavedChange;
  });
  // Trimmed Markdown: the editor's document after its latest change, the document as last loaded or saved, and the
  // document most recently queued for saving. The latest document is kept here because the editor may already be
  // destroyed when unmounting saves it.
  const latest = useRef("");
  const lastSaved = useRef("");
  const lastSubmitted = useRef("");
  // Content the server rejected for good (validation, ended session): not submitted again until the text changes.
  const rejected = useRef<string | undefined>(undefined);
  // Write access ended (403): nothing is saved or drafted any more.
  const locked = useRef(false);
  // The `value` the editor last loaded, and a newer one it has not shown yet because the user was in the editor.
  const loaded = useRef(value);
  const pending = useRef<string | undefined>(undefined);
  const edited = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // The latest document once the user has edited it; undefined before the first edit.
  const [doc, setDoc] = useState<string>();
  const [saved, setSaved] = useState("");
  const [savesInFlight, setSavesInFlight] = useState(0);
  const [error, setError] = useState<SaveFailure>();
  const [readOnly, setReadOnly] = useState(false);
  const [recovery, setRecovery] = useState<DocumentationDraft>();

  const commit = useCallback((next: string) => {
    if (locked.current) return;
    if (next === lastSubmitted.current) {
      // Nothing new to save, and a document that matches the saved one has no failed save to report.
      if (next === lastSaved.current) setError(undefined);
      return;
    }
    if (next === rejected.current) return;
    // Over the limit: the notice comes from the document's length, and the text stays in the draft.
    if (next.length > MAX_DOCUMENTATION_LENGTH) return;
    lastSubmitted.current = next;
    // This save replaces documentation that changed elsewhere in the meantime (the last write wins).
    pending.current = undefined;
    // Captured now: this save may finish after the editor unmounted, and must still settle this object's draft.
    const target = locationRef.current;
    setSavesInFlight((count) => count + 1);
    setError(undefined);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        if (locked.current) return;
        await save.current(next);
        lastSaved.current = next;
        setSaved(next);
        setError(undefined);
        // Co-editing is last-write-wins in this increment: this save lands after any update that arrived while it was
        // in flight, so that update is no longer waiting to be shown.
        pending.current = undefined;
        // A newer unsaved document keeps the draft, which then holds that newer text.
        if (target && latest.current === next) clearDraft(target.userId, target.kind, target.objectId);
      } catch (cause) {
        const failure = classifySaveError(cause);
        if (failure.kind === "forbidden") {
          locked.current = true;
          if (target) clearDraft(target.userId, target.kind, target.objectId);
          setReadOnly(true);
          setRecovery(undefined);
          setError(undefined);
          return;
        }
        // Submit it again on the next attempt, unless a newer document is already queued.
        if (lastSubmitted.current === next) lastSubmitted.current = lastSaved.current;
        if (failure.kind !== "transient") rejected.current = next;
        setError(failure);
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
    if (next !== rejected.current) rejected.current = undefined;
    setDoc(next);
    // Typing supersedes an offer to restore an older draft; the draft is overwritten below.
    setRecovery(undefined);
    const target = locationRef.current;
    if (target && !locked.current) {
      if (next !== lastSaved.current) writeDraft(target.userId, target.kind, target.objectId, next);
      else if (lastSubmitted.current === lastSaved.current) clearDraft(target.userId, target.kind, target.objectId);
    }
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
    setDoc((current) => (current === undefined ? undefined : replaced));
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
    // changed, so nothing is saved. The draft is written first, so the text survives a failed or interrupted save.
    return () => {
      const target = locationRef.current;
      if (target && !locked.current && edited.current && latest.current !== lastSaved.current)
        writeDraft(target.userId, target.kind, target.objectId, latest.current);
      commit(latest.current);
    };
  }, [commit]);

  // Offers the stored draft once the draft location is known, and withdraws the offer when it goes away.
  const userId = location?.userId;
  const kind = location?.kind;
  const objectId = location?.objectId;
  useEffect(() => {
    const target = userId === undefined || !kind || objectId === undefined ? undefined : { userId, kind, objectId };
    if (!target || locked.current) {
      setRecovery(undefined);
      return;
    }
    if (edited.current && latest.current !== lastSaved.current) {
      // Edits made before the location was known are unsaved too: keep them instead of offering an older draft.
      writeDraft(target.userId, target.kind, target.objectId, latest.current);
      setRecovery(undefined);
      return;
    }
    const found = readDraft(target.userId, target.kind, target.objectId);
    if (!found) {
      setRecovery(undefined);
      return;
    }
    const markdown = found.markdown.trim();
    if (markdown === currentValue.current.trim() || markdown === lastSaved.current) {
      clearDraft(target.userId, target.kind, target.objectId);
      setRecovery(undefined);
      return;
    }
    setRecovery(found);
  }, [userId, kind, objectId]);

  useEffect(() => {
    if (doc === undefined) return;
    const timer = setTimeout(() => commit(doc), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [doc, commit]);

  // Documentation changed elsewhere replaces the editor's document only while the user is not working on it. An update
  // that arrives while the editor has focus is shown when the user leaves it without an edit. Otherwise the editor keeps
  // its document, and the next save writes over the update (the last write wins; there is no merge in this increment).
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

  const restoreDraft = () => {
    const handle = editor.current;
    const found = recovery;
    setRecovery(undefined);
    if (!handle || !found) return;
    // Restoring is an edit like any other: it autosaves, and shows the over-limit notice when it is too long.
    handleChange(handle.replace(found.markdown));
    const target = locationRef.current;
    if (target && latest.current === lastSaved.current) clearDraft(target.userId, target.kind, target.objectId);
  };
  const discardDraft = () => {
    const target = locationRef.current;
    if (target) clearDraft(target.userId, target.kind, target.objectId);
    setRecovery(undefined);
  };

  const overBy = doc !== undefined ? doc.length - MAX_DOCUMENTATION_LENGTH : 0;
  // Content that is not safely saved: unsaved, in flight, failed, or over the limit.
  const unsaved = !readOnly && doc !== undefined && (doc !== saved || savesInFlight > 0 || !!error);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const reported = useRef(false);
  useEffect(() => {
    if (reported.current === unsaved) return;
    reported.current = unsaved;
    reportUnsaved.current?.(unsaved);
  }, [unsaved]);
  // A closed editor no longer holds unsaved content for its container; its draft and any save in flight carry on.
  useEffect(
    () => () => {
      if (!reported.current) return;
      reported.current = false;
      reportUnsaved.current?.(false);
    },
    [],
  );

  if (readOnly) {
    return (
      <section className="documentation-card" aria-label="Documentation">
        <p className="documentation-notice is-error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>You can no longer edit this documentation. Your changes could not be saved.</span>
        </p>
        <MarkdownContent value={value} />
      </section>
    );
  }

  // The dot's colour and the text a screen reader reads come from one value, so they cannot disagree. Documentation that
  // is too long has not been sent and so is only unsaved; a failed save is what the error state is for.
  const saveState =
    doc === undefined
      ? undefined
      : error
        ? { state: "error", label: "Save failed" }
        : savesInFlight > 0
          ? { state: "saving", label: "Saving…" }
          : doc !== saved
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
          <>
            {recovery && (
              <section className="documentation-notice is-recovery" aria-label="Unsaved documentation found">
                <CircleAlert size={15} aria-hidden="true" />
                <span>Unsaved documentation from {describeAge(recovery.savedAt)} was kept on this device.</span>
                <button type="button" onClick={restoreDraft}>
                  Restore
                </button>
                <button type="button" onClick={discardDraft}>
                  Discard
                </button>
              </section>
            )}
            {overBy > 0 && (
              <p className="documentation-notice is-error" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>{tooLongMessage(overBy)}</span>
              </p>
            )}
            {error && (
              <p className="documentation-notice is-error" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>{error.message}</span>
                {error.kind === "transient" && (
                  <button type="button" onClick={() => commit(latest.current)}>
                    Retry
                  </button>
                )}
              </p>
            )}
          </>
        }
      />
    </section>
  );
}
