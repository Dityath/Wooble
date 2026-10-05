import { onTestFinished } from "bun:test";
import { act, render } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { createElement } from "react";
import {
  type DocumentationExtensionOptions,
  documentationExtensions,
} from "../../src/features/inspector/documentation/extensions";

export interface DocumentationEditorOptions extends DocumentationExtensionOptions {
  /** Element to render the editor into, such as a `role="dialog"` element. Defaults to a new element in the body. */
  container?: HTMLElement;
}

/**
 * Renders an editable documentation editor loaded from `markdown` the way the app does (`useEditor` and
 * `EditorContent`), so React renderers such as the slash menu mount as well. Returns the editor and its
 * contenteditable element. Call it inside a test or a `beforeEach` hook: Testing Library unmounts the editor after the
 * test, and it is then destroyed, so nothing carries over into the next test.
 */
export function renderDocumentationEditor(markdown = "", { container, ...options }: DocumentationEditorOptions = {}) {
  const editorOptions = {
    extensions: documentationExtensions(options),
    content: markdown,
    contentType: "markdown" as const,
  };
  const rendered: { editor?: Editor } = {};
  function DocumentationEditor() {
    rendered.editor = useEditor(editorOptions);
    return createElement(EditorContent, { editor: rendered.editor });
  }
  render(createElement(DocumentationEditor), { container });
  const { editor } = rendered;
  if (!editor) throw new Error("The documentation editor did not render.");
  // useEditor destroys an unmounted editor on a later timer; destroy it before the next test starts instead.
  onTestFinished(() => editor.destroy());
  return { editor, element: editor.view.dom as HTMLElement };
}

/** Returns the editor that TipTap attaches to its contenteditable element, such as one a component rendered. */
export function editorFromElement(element: Element) {
  const { editor } = element as Element & { editor?: Editor };
  if (!editor) throw new Error("The element is not a TipTap editor.");
  return editor;
}

/**
 * Types `text` at the editor's selection through ProseMirror's text input handling, as browser typing does, so
 * Markdown shortcuts (`# `, `[ ] `) and the `/` trigger run and update events fire. It focuses the editor first.
 *
 * Type text with this rather than user-event: happy-dom has no layout, so a click cannot place the caret, and in an
 * empty document user-event types outside the paragraph. Move the caret with editor commands such as
 * `setTextSelection`. Enter, Backspace, arrows, and Escape work with user-event's `keyboard` once the editor has focus.
 */
export async function typeInEditor(target: Editor | Element, text: string) {
  if (/[\r\n]/.test(text)) throw new Error("Press Enter with user-event's keyboard to start a new block.");
  const editor = target instanceof Element ? editorFromElement(target) : target;
  const { view } = editor;
  // Async act also flushes React renderers, which TipTap updates in a microtask.
  await act(async () => {
    if (!view.hasFocus()) view.focus();
    for (const character of text) {
      const { from, to } = view.state.selection;
      const insert = () => view.state.tr.insertText(character, from, to);
      if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, character, insert)))
        view.dispatch(insert());
    }
  });
}
