import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Passes an Escape that something around the editor has already default-prevented to the editor's key handlers.
 *
 * A modal dialog such as the canvas details dialog listens for Escape on the document in the capture phase, before the
 * editor, and calls `preventDefault` to stay open while an inline editor has focus (`data-inline-editing`). ProseMirror
 * ignores key events whose default is already prevented, so neither the slash menu nor the editor's Escape shortcut
 * would see that Escape. The handlers run in their usual order, so the slash menu closes before a lower-priority
 * shortcut leaves the editor.
 *
 * The listener runs in the capture phase, before ProseMirror's own key handling, so that an Escape ProseMirror handles
 * and then prevents itself is not handled a second time.
 */
export const PreventedEscape = Extension.create({
  name: "preventedEscape",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("preventedEscape"),
        view(view) {
          const passPreventedEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !event.defaultPrevented || event.isComposing) return;
            view.someProp("handleKeyDown", (handleKeyDown) => handleKeyDown(view, event));
          };
          view.dom.addEventListener("keydown", passPreventedEscape, true);
          return { destroy: () => view.dom.removeEventListener("keydown", passPreventedEscape, true) };
        },
      }),
    ];
  },
});
