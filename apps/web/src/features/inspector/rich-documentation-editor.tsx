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
import {
  classifySaveError,
  OVER_LIMIT_MESSAGE,
  removeCharactersMessage,
  type SaveFailure,
} from "./documentation/save-errors";

export const AUTOSAVE_DELAY_MS = 900;
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

/** The older draft above the fresh edits, with a blank line between; either part may be empty. */
function combine(older: string, fresh: string): string {
  return [older.trim(), fresh].filter((part) => part !== "").join("\n\n");
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
 * rejected save does not lose it. A failed save is handled by its status: a 403 keeps the text visible but read-only,
 * other rejections do not offer a pointless retry, and network or server failures (and an ended session, once the user
 * has signed in again) can be retried by hand.
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
  const failureNotice = useRef<HTMLParagraphElement>(null);
  // The `value` the editor last loaded, and a newer one it has not shown yet because the user was in the editor.
  const loaded = useRef(value);
  const pending = useRef<string | undefined>(undefined);
  const edited = useRef(false);
  // A recovery offer is open. Rule: while it is, NOTHING is sent to the server for this object (no autosave, blur or
  // unmount save) and nothing writes to or clears its draft slot, because the slot still holds the older draft the user
  // has not decided about. Fresh edits made before the offer appeared stay in the read-only editor, unsaved.
  // Discard removes the older draft, then autosave resumes with the fresh edits; Restore puts the older draft above the
  // fresh edits (blank line between) and autosaves that. "Fresh" means `latest.current !== lastSaved.current`, read when
  // it is needed: nothing new is submitted during the offer, so `lastSaved` only moves when a save that was already in
  // flight lands, and text that save carried is then no longer fresh. If the editor closes with the offer open and fresh
  // edits, the combined text (older draft, blank line, fresh edits) becomes the draft, so the next mount offers both.
  const offerOpen = useRef(false);
  const unmounted = useRef(false);
  const offerDraft = useRef("");
  const restoreButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  // The latest document once the user has edited it; undefined before the first edit.
  const [doc, setDoc] = useState<string>();
  const [saved, setSaved] = useState("");
  const [savesInFlight, setSavesInFlight] = useState(0);
  const [error, setError] = useState<SaveFailure>();
  const [accessLost, setAccessLost] = useState(false);
  const [recovery, setRecovery] = useState<DocumentationDraft>();
  // The open offer was made over edits that are not saved; false again once a save already in flight has landed.
  const offerHasFreshEdits = !!recovery && doc !== undefined && doc !== saved;
  // Bumped when an offer is resolved, so the autosave that was held back starts again.
  const [resumeTick, setResumeTick] = useState(0);
  // Bumped when focus should return to the editor after a control that held it went away.
  const [focusRequest, setFocusRequest] = useState(0);

  const commit = useCallback((next: string) => {
    if (locked.current || offerOpen.current) return;
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
        // The draft follows the latest text: cleared when it is what was saved, rewritten when the user went on (or back
        // to the previously saved text) while this save was in flight.
        if (offerOpen.current) {
          // The editor closed during the offer and stored the fresh text next to the older draft; that text is saved now.
          // The offer belongs to the current location, which may differ from the one this save started with.
          const open = locationRef.current;
          if (open && unmounted.current && !locked.current && latest.current === next)
            writeDraft(open.userId, open.kind, open.objectId, offerDraft.current);
        } else if (target) {
          if (latest.current === next) clearDraft(target.userId, target.kind, target.objectId);
          else writeDraft(target.userId, target.kind, target.objectId, latest.current);
        }
      } catch (cause) {
        const failure = classifySaveError(cause);
        if (failure.kind === "forbidden") {
          locked.current = true;
          if (target) clearDraft(target.userId, target.kind, target.objectId);
          setAccessLost(true);
          offerOpen.current = false;
          setRecovery(undefined);
          setError(failure);
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
    const target = locationRef.current;
    if (target && !locked.current && !offerOpen.current) {
      // Whatever a save in flight carries, the draft holds the latest text, and nothing once that is the saved text.
      if (next !== lastSaved.current) writeDraft(target.userId, target.kind, target.objectId, next);
      else clearDraft(target.userId, target.kind, target.objectId);
    }
  }, []);

  /**
   * Shows documentation that changed elsewhere, unless the user is working on it: the editor has focus, unsaved changes,
   * or a save in progress. Returns whether it was shown.
   */
  const show = useCallback((next: string) => {
    const handle = editor.current;
    if (!handle || offerOpen.current || handle.hasFocus() || latest.current !== lastSaved.current) return false;
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
    unmounted.current = false;
    const loadedMarkdown = editor.current?.getMarkdown().trim() ?? "";
    latest.current = loadedMarkdown;
    lastSaved.current = loadedMarkdown;
    lastSubmitted.current = loadedMarkdown;
    setSaved(loadedMarkdown);
    // Closing the editor before the autosave saves the pending edit. Under StrictMode's extra unmount nothing has
    // changed, so nothing is saved. The draft is written first, so the text survives a failed or interrupted save.
    return () => {
      unmounted.current = true;
      const target = locationRef.current;
      if (offerOpen.current) {
        // Nothing is sent while the offer is open. Fresh edits are kept next to the older draft instead of replacing it.
        if (target && !locked.current && edited.current && latest.current !== lastSaved.current)
          writeDraft(target.userId, target.kind, target.objectId, combine(offerDraft.current, latest.current));
        return;
      }
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
    const offer = (draftToOffer: DocumentationDraft | undefined) => {
      offerOpen.current = draftToOffer !== undefined;
      offerDraft.current = draftToOffer?.markdown.trim() ?? "";
      setRecovery(draftToOffer);
      // A withdrawn offer lets the autosave that was held back run.
      if (draftToOffer === undefined) setResumeTick((count) => count + 1);
    };
    const target = userId === undefined || !kind || objectId === undefined ? undefined : { userId, kind, objectId };
    if (!target || locked.current) {
      offer(undefined);
      return;
    }
    // Edits made before the location was known are unsaved too. They must not replace an older stored draft that was
    // never shown to the user, so they are written only when no older draft needs a decision.
    const fresh = edited.current && latest.current !== lastSaved.current;
    const keepFresh = () => {
      if (fresh) writeDraft(target.userId, target.kind, target.objectId, latest.current);
    };
    const found = readDraft(target.userId, target.kind, target.objectId);
    if (!found) {
      keepFresh();
      offer(undefined);
      return;
    }
    const markdown = found.markdown.trim();
    if (markdown === currentValue.current.trim() || markdown === lastSaved.current) {
      clearDraft(target.userId, target.kind, target.objectId);
      keepFresh();
      offer(undefined);
      return;
    }
    if (fresh && markdown === latest.current) {
      // The stored draft is already the text in the editor.
      offer(undefined);
      return;
    }
    offer(found);
  }, [userId, kind, objectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resumeTick only restarts the autosave that an open offer held back.
  useEffect(() => {
    if (doc === undefined) return;
    const timer = setTimeout(() => commit(doc), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [doc, commit, resumeTick]);

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

  // Keystrokes were dropped when the editor went read-only, so the offer takes the focus when it follows typing.
  // Focus only moves when it is in the documentation (or nowhere): the offer can appear late, after the user went on to
  // another control. It is still announced, because it is an alert.
  useEffect(() => {
    const active = document.activeElement;
    const here = !active || active === document.body || !!panel.current?.contains(active);
    if (recovery && here && (offerHasFreshEdits || editor.current?.hasFocus())) restoreButton.current?.focus();
  }, [recovery, offerHasFreshEdits]);
  useEffect(() => {
    if (focusRequest > 0) editor.current?.focus();
  }, [focusRequest]);
  // The notice that ends editing takes the focus from the text, which can no longer change.
  useEffect(() => {
    if (accessLost) failureNotice.current?.focus();
  }, [accessLost]);

  const restoreDraft = () => {
    const handle = editor.current;
    const found = recovery;
    // Read before the offer closes: fresh edits are what the read-only editor holds beyond the document the offer saw.
    const fresh = edited.current && latest.current !== lastSaved.current ? latest.current : "";
    offerOpen.current = false;
    setRecovery(undefined);
    setResumeTick((count) => count + 1);
    setFocusRequest((count) => count + 1);
    if (!handle || !found) return;
    // Fresh edits typed while the offer was pending stay: the older draft goes above them instead of replacing them.
    const restored = combine(found.markdown, fresh);
    // Restoring is an edit like any other: it autosaves, and shows the over-limit notice when it is too long. A draft
    // of deleted documentation restores to empty documentation.
    handleChange(handle.replace(fresh ? restored : found.markdown));
    const target = locationRef.current;
    if (target && latest.current === lastSaved.current) clearDraft(target.userId, target.kind, target.objectId);
  };
  const discardDraft = () => {
    const target = locationRef.current;
    offerOpen.current = false;
    if (target) {
      clearDraft(target.userId, target.kind, target.objectId);
      // Fresh edits typed while the offer was pending become the draft now that the slot is free.
      if (edited.current && latest.current !== lastSaved.current && !locked.current)
        writeDraft(target.userId, target.kind, target.objectId, latest.current);
    }
    setRecovery(undefined);
    setResumeTick((count) => count + 1);
    setFocusRequest((count) => count + 1);
  };
  // A manual retry also covers a failure that is not retried by itself, such as an ended session.
  const retry = () => {
    rejected.current = undefined;
    commit(latest.current);
    setFocusRequest((count) => count + 1);
  };

  const overBy = doc !== undefined ? doc.length - MAX_DOCUMENTATION_LENGTH : 0;
  // Content that is not safely saved: unsaved, in flight, failed, or over the limit.
  const unsaved = !accessLost && doc !== undefined && (doc !== saved || savesInFlight > 0 || !!error);

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

  // The visual label shows every state. Only the terminal "Saved" is announced: "Unsaved changes" and "Saving…" would
  // repeat on every pause in typing, and a failure is announced by its own alert. Documentation that is too long has
  // not been sent and so is only unsaved; a failed save is what the error state is for.
  const saveState =
    doc === undefined
      ? undefined
      : accessLost
        ? { state: "error", label: "Not saved" }
        : error
          ? { state: "error", label: "Save failed" }
          : savesInFlight > 0
            ? { state: "saving", label: "Saving…" }
            : doc !== saved
              ? { state: "unsaved", label: "Unsaved changes" }
              : { state: "saved", label: "Saved" };
  return (
    <section ref={panel} className="documentation-card" aria-label="Documentation">
      <DocumentationEditor
        ref={editor}
        initialMarkdown={value}
        onChange={handleChange}
        onBlur={handleBlur}
        // The user decides about the older draft first, so typing cannot silently overwrite it.
        readOnly={accessLost || !!recovery}
        invalid={overBy > 0}
        status={
          <>
            <span className="documentation-save-state" data-state={saveState?.state}>
              {saveState?.label ?? ""}
            </span>
            {/* Mounted while there is nothing to report, so the first "Saved" is announced too. */}
            <span className="documentation-live" role="status">
              {saveState?.state === "saved" ? "Saved" : ""}
            </span>
          </>
        }
        notice={
          <>
            {recovery && (
              <p className="documentation-notice is-recovery" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>
                  {recovery.markdown.trim() === "" ? "Deleted documentation" : "Unsaved documentation"} from{" "}
                  {describeAge(recovery.savedAt)} was kept on this device. Editing is paused. Restore or discard it to
                  keep editing.
                  {offerHasFreshEdits && " Restoring puts the earlier draft above what you typed."}
                </span>
                <button ref={restoreButton} type="button" onClick={restoreDraft}>
                  Restore
                </button>
                <button type="button" onClick={discardDraft}>
                  Discard saved copy
                </button>
              </p>
            )}
            {overBy > 0 && (
              <p className="documentation-notice is-error">
                <CircleAlert size={15} aria-hidden="true" />
                <span>
                  {/* A constant sentence is announced once; the number changes with every keystroke, so it is not live. */}
                  <span role="status">{OVER_LIMIT_MESSAGE}</span> <span>{removeCharactersMessage(overBy)}</span>
                </span>
              </p>
            )}
            {error && (
              <p ref={failureNotice} tabIndex={-1} className="documentation-notice is-error" role="alert">
                <CircleAlert size={15} aria-hidden="true" />
                <span>{error.message}</span>
                {(error.kind === "transient" || error.kind === "session") && (
                  <button type="button" onClick={retry}>
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
