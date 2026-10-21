import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Blocks, FileCode2, TriangleAlert } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  /** Moves the keyboard focus into the document. */
  focus: () => void;
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
  /** The text stays visible and selectable, but cannot be edited. */
  readOnly?: boolean;
  /** Marks the document as invalid for assistive technology, such as while it is over the length limit. */
  invalid?: boolean;
  ref?: Ref<DocumentationEditorHandle>;
}

export interface DocumentationEditorChrome {
  /** Shown at the start of the toolbar, such as the save state. */
  status?: ReactNode;
  /** Shown between the toolbar and the document, such as a failed save. */
  notice?: ReactNode;
}

/** An always-editable block editor for Markdown documentation. */
function BlockDocumentationEditor({
  initialMarkdown,
  onChange,
  onBlur,
  readOnly,
  invalid,
  ref,
}: DocumentationEditorProps) {
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
  useEffect(() => {
    // Not announced as an update: a change of mode is not an edit.
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  useEffect(() => {
    // Set on the element itself: replacing editorProps would drop attributes that plugins add to the editable.
    const apply = () => {
      let dom: HTMLElement;
      try {
        dom = editor.view.dom;
      } catch {
        // TipTap throws until the view is mounted; the "mount" listener below applies it then.
        return;
      }
      if (invalid) dom.setAttribute("aria-invalid", "true");
      else dom.removeAttribute("aria-invalid");
    };
    apply();
    editor.on("mount", apply);
    return () => {
      editor.off("mount", apply);
    };
  }, [editor, invalid]);
  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => editor.getMarkdown(),
      hasFocus: () => editor.isFocused,
      focus: () => {
        editor.commands.focus();
      },
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
export function DocumentationEditor({
  initialMarkdown,
  onChange,
  onBlur,
  readOnly,
  invalid,
  ref,
  status,
  notice,
}: DocumentationEditorProps & DocumentationEditorChrome) {
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
      focus: () => {
        if (sourceValue.current !== undefined) textarea.current?.focus();
        else blocks.current?.focus();
      },
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
      {/* Notices stay with the sticky toolbar, so a warning raised by a paste further down remains in view. */}
      <div className="documentation-chrome">
        <div className="documentation-toolbar">
          <div className="documentation-toolbar-status">{status}</div>
          {inSource ? (
            <span className="documentation-hint">Markdown source</span>
          ) : (
            <span className="documentation-hint">
              Type <kbd>/</kbd> to insert a block. Paste Markdown to convert it.
            </span>
          )}
          {readOnly ? null : inSource ? (
            !sourceWarning && (
              <button type="button" className="documentation-mode-toggle" onClick={useBlocks}>
                <Blocks size={14} aria-hidden="true" />
                Edit as blocks
              </button>
            )
          ) : (
            <button type="button" className="documentation-mode-toggle" onClick={useSource}>
              <FileCode2 size={14} aria-hidden="true" />
              Edit Markdown source
            </button>
          )}
        </div>
        {notice}
        {warning && (
          <p className="documentation-notice is-warning" role="alert">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              {inSource
                ? `This document contains ${warning}, which the block editor does not support. Edit it here in Markdown source; unsupported content is kept verbatim.`
                : `Paste cancelled: it contains ${warning}, which the block editor does not support. Choose "Edit Markdown source", then paste again to keep it verbatim.`}
            </span>
          </p>
        )}
      </div>
      {inSource ? (
        <textarea
          ref={textarea}
          aria-label="Documentation"
          data-inline-editing="true"
          className="documentation-source"
          spellCheck={false}
          readOnly={readOnly}
          aria-invalid={invalid || undefined}
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
      ) : (
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
            readOnly={readOnly}
            invalid={invalid}
          />
        </div>
      )}
    </>
  );
}
