import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../components/ui";

export function MarkdownContent({ value }: { value: string }) {
  return value ? (
    <article className="rich-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </article>
  ) : (
    <p className="rich-empty">No documentation yet. Select Edit to start writing.</p>
  );
}

export function RichDocumentation({ value, onSave }: { value: string; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lastSubmitted = useRef(value);
  const lastSaved = useRef(value);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) {
      setDraft(value);
      lastSubmitted.current = value;
      lastSaved.current = value;
    }
  }, [value, editing]);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);
  const commit = useCallback(
    (next: string) => {
      if (next === lastSubmitted.current) return saveQueue.current;
      lastSubmitted.current = next;
      setSaving(true);
      setError("");
      saveQueue.current = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await onSave(next);
            lastSaved.current = next;
            setError("");
          } catch (cause) {
            lastSubmitted.current = lastSaved.current;
            setError(cause instanceof Error ? cause.message : "Could not save documentation");
            throw cause;
          } finally {
            setSaving(false);
          }
        });
      return saveQueue.current;
    },
    [onSave],
  );
  useEffect(() => {
    if (!editing || draft === lastSubmitted.current) return;
    const timer = setTimeout(() => {
      void commit(draft).catch(() => undefined);
    }, 900);
    return () => clearTimeout(timer);
  }, [draft, editing, commit]);
  const cancel = () => {
    setDraft(lastSaved.current);
    setEditing(false);
    setError("");
  };
  return (
    <section className="rich-detail-card documentation-card">
      <div className="rich-detail-heading">
        <div>
          <h3>Documentation</h3>
          <p>Markdown with a live reading view.</p>
        </div>
        <div className="rich-detail-actions">
          {editing ? (
            <>
              <span className="documentation-save-state" role="status">
                {saving ? "Saving…" : draft !== lastSaved.current ? "Unsaved changes" : "Saved"}
              </span>
              <Button size="sm" variant="ghost" onPointerDown={(event) => event.preventDefault()} onClick={cancel}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void commit(draft)
                    .then(() => setEditing(false))
                    .catch(() => undefined);
                }}
              >
                Done
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="documentation-workspace">
          <div className="documentation-source">
            <span>MARKDOWN</span>
            <textarea
              ref={textareaRef}
              data-inline-editing="true"
              aria-label="Documentation Markdown"
              className="rich-source-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit(draft).catch(() => undefined)}
              maxLength={20000}
              placeholder={"# Overview\n\nDescribe this component…"}
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void commit(draft)
                    .then(() => setEditing(false))
                    .catch(() => undefined);
                }
              }}
            />
          </div>
          <div className="documentation-preview">
            <span>PREVIEW</span>
            <MarkdownContent value={draft} />
          </div>
        </div>
      ) : (
        <MarkdownContent value={value} />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => void commit(draft).catch(() => undefined)}>
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
