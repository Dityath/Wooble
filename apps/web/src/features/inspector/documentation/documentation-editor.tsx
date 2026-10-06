import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type Ref, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { documentationEditorOptions, documentationExtensions } from "./extensions";
import { looksLikeMarkdown } from "./markdown-paste";
import { unsupportedMarkdown } from "./unsupported-markdown";

/**
 * Escape leaves the editor, and leaving it saves. The details dialog stays open on that Escape because the editor
 * element has `data-inline-editing`; the next Escape closes the dialog.
 *
 * It is a low-priority keyboard shortcut so that extensions with the default priority, such as the slash menu, claim
 * Escape first. `editorProps.handleKeyDown` would run before every plugin, so the slash menu could not close first. The
 * dialog prevents that Escape before the editor sees it; `PreventedEscape` passes it on.
 */
const BlurOnEscape = Extension.create({
  name: "documentationBlurOnEscape",
  priority: 50,
  addKeyboardShortcuts() {
    return { Escape: ({ editor }) => editor.commands.blur() };
  },
});

export interface DocumentationEditorHandle {
  /** The Markdown the editor writes for its document. */
  getMarkdown: () => string;
  hasFocus: () => boolean;
  /**
   * Replaces the document with `markdown` without calling `onChange` or adding an undo step, and returns the Markdown
   * the editor writes for the new document.
   */
  replace: (markdown: string) => string;
}

export interface DocumentationEditorProps {
  /** The Markdown the editor opens. Later changes to it are ignored; use the handle's `replace` instead. */
  initialMarkdown: string;
  /** Called with the editor's Markdown after each change to the document, including ones the editor makes itself. */
  onChange: (markdown: string) => void;
  onBlur: () => void;
  ref?: Ref<DocumentationEditorHandle>;
}

/** An always-editable block editor for Markdown documentation. */
function BlockDocumentationEditor({ initialMarkdown, onChange, onBlur, ref }: DocumentationEditorProps) {
  // The editor reads these when it is created. Keeping them stable also stops useEditor from reapplying them on every
  // render; it always calls the latest event handlers.
  const [options] = useState(() => ({
    ...documentationEditorOptions,
    extensions: [...documentationExtensions({ placeholder: 'Type "/" for blocks, or paste Markdown' }), BlurOnEscape],
    content: initialMarkdown,
    contentType: "markdown" as const,
    editorProps: {
      // TipTap adds role="textbox".
      attributes: {
        "aria-label": "Documentation",
        "aria-multiline": "true",
        "data-inline-editing": "true",
        // Shares the reading view's typography.
        class: "rich-markdown documentation-editor",
      },
    },
  }));
  const editor = useEditor({
    ...options,
    onUpdate: ({ editor: updated }) => onChange(updated.getMarkdown()),
    onBlur: () => onBlur(),
  });
  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => editor.getMarkdown(),
      hasFocus: () => editor.isFocused,
      replace(markdown) {
        editor
          .chain()
          // Undoing must not bring back the replaced document, which the next save would then write over the update.
          .setMeta("addToHistory", false)
          .setContent(markdown, { contentType: "markdown", emitUpdate: false })
          .run();
        return editor.getMarkdown();
      },
    }),
    [editor],
  );
  return <EditorContent editor={editor} className="documentation-surface" />;
}

/** Unsupported documents stay in source form, with the same autosave contract as block editing. */
export function DocumentationEditor({ initialMarkdown, onChange, onBlur, ref }: DocumentationEditorProps) {
  const [source, setSource] = useState(() =>
    unsupportedMarkdown(initialMarkdown).length ? initialMarkdown : undefined,
  );
  // The Markdown the block editor opens: the documentation, or the source when switching back from source mode.
  const [blockMarkdown, setBlockMarkdown] = useState(initialMarkdown);
  const sourceValue = useRef(source);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const blocks = useRef<DocumentationEditorHandle>(null);
  const original = useRef(initialMarkdown);
  const baseline = useRef("");
  const edited = useRef(false);
  const inSource = source !== undefined;
  useLayoutEffect(() => {
    if (!inSource) baseline.current = blocks.current?.getMarkdown().trim() ?? blockMarkdown.trim();
  }, [blockMarkdown, inSource]);
  // Describes the source as it is now, so removing the unsupported content clears it.
  const sourceWarning = useMemo(() => (source === undefined ? "" : unsupportedMarkdown(source).join(", ")), [source]);
  const [pasteWarning, setPasteWarning] = useState("");
  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => sourceValue.current ?? blocks.current?.getMarkdown() ?? initialMarkdown,
      hasFocus: () =>
        sourceValue.current !== undefined
          ? document.activeElement === textarea.current
          : (blocks.current?.hasFocus() ?? false),
      replace(markdown) {
        original.current = markdown;
        edited.current = false;
        const unsupported = unsupportedMarkdown(markdown);
        if (sourceValue.current !== undefined || unsupported.length) {
          sourceValue.current = markdown;
          setSource(markdown);
          setPasteWarning("");
          return markdown;
        }
        const replaced = blocks.current?.replace(markdown) ?? markdown;
        baseline.current = replaced.trim();
        return replaced;
      },
    }),
    [initialMarkdown],
  );
  const useSource = () => {
    const markdown = edited.current ? (blocks.current?.getMarkdown() ?? original.current) : original.current;
    sourceValue.current = markdown;
    setPasteWarning("");
    setSource(markdown);
  };
  // Reopens the source in the block editor. Only offered while the source has nothing the blocks would lose.
  const useBlocks = () => {
    if (source === undefined) return;
    original.current = source;
    edited.current = false;
    sourceValue.current = undefined;
    setBlockMarkdown(source);
    setSource(undefined);
  };
  const warning = inSource ? sourceWarning : pasteWarning;
  return (
    <>
      {warning && (
        <p className="form-error" role="alert">
          {inSource
            ? `This document contains ${warning}, which the block editor does not support. Edit Markdown source to preserve this content.`
            : `This paste contains ${warning}, which the block editor does not support. Switch to Markdown source, then paste again to preserve it.`}
        </p>
      )}
      {inSource ? (
        <>
          {!sourceWarning && (
            <button type="button" className="documentation-source-toggle" onClick={useBlocks}>
              Edit as blocks
            </button>
          )}
          <textarea
            ref={textarea}
            aria-label="Documentation"
            data-inline-editing="true"
            className="documentation-surface documentation-source"
            value={source}
            onChange={(event) => {
              sourceValue.current = event.target.value;
              setSource(event.target.value);
              onChange(event.target.value);
            }}
            onBlur={onBlur}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </>
      ) : (
        <>
          <button type="button" className="documentation-source-toggle" onClick={useSource}>
            Edit Markdown source
          </button>
          <div
            onPasteCapture={(event) => {
              // Pasting source inside a code block is literal, even when it contains Markdown or HTML.
              const selection = window.getSelection();
              const selectedElement =
                selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
              if (selectedElement?.closest("pre")) return;
              // Only text that MarkdownPaste reads as Markdown can lose unsupported syntax. Rich HTML keeps the default
              // paste, and ordinary text that merely mentions `<Button>` or `[^1]` is pasted literally.
              const clipboard = event.clipboardData;
              if (clipboard.getData("text/html") && !clipboard.getData("vscode-editor-data")) return;
              const plain = clipboard.getData("text/plain");
              if (!looksLikeMarkdown(plain)) return;
              const unsupported = unsupportedMarkdown(plain);
              if (!unsupported.length) return;
              event.preventDefault();
              event.stopPropagation();
              setPasteWarning(unsupported.join(", "));
            }}
          >
            <BlockDocumentationEditor
              ref={blocks}
              initialMarkdown={blockMarkdown}
              onChange={(markdown) => {
                // Not an edit, such as the empty paragraph added after a final table when the editor is first focused.
                // After switching back from source, forwarding it would save the source rewritten in canonical form.
                if (!edited.current && markdown.trim() === baseline.current) return;
                edited.current = true;
                setPasteWarning("");
                onChange(markdown);
              }}
              onBlur={onBlur}
            />
          </div>
        </>
      )}
    </>
  );
}
