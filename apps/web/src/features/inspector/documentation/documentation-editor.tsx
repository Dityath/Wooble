import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type Ref, useImperativeHandle, useState } from "react";
import { documentationEditorOptions, documentationExtensions } from "./extensions";

/**
 * Escape leaves the editor, and leaving it saves. The details dialog stays open on that Escape because the editor
 * element has `data-inline-editing`; the next Escape closes the dialog.
 *
 * It is a low-priority keyboard shortcut so that extensions with the default priority, such as the slash menu, claim
 * Escape first. `editorProps.handleKeyDown` would run before every plugin, so the slash menu could not close first.
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
export function DocumentationEditor({ initialMarkdown, onChange, onBlur, ref }: DocumentationEditorProps) {
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
  return (
    <EditorContent
      editor={editor}
      className="documentation-surface"
      onKeyDownCapture={(event) => {
        // ProseMirror ignores a key event whose default action is already prevented. The details dialog prevents
        // Escape, on the document before the editor sees it, to stay open while the editor has focus. Pass that
        // Escape to the editor's key handlers in their usual order, so the slash menu closes first and BlurOnEscape
        // runs otherwise.
        const { nativeEvent } = event;
        if (nativeEvent.key !== "Escape" || !nativeEvent.defaultPrevented || nativeEvent.isComposing) return;
        const { view } = editor;
        view.someProp("handleKeyDown", (handleKeyDown) => handleKeyDown(view, nativeEvent));
      }}
    />
  );
}
