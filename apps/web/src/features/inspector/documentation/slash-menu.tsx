import { flip, shift } from "@floating-ui/dom";
import { type Editor, Extension, type Range } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { exitSuggestion, Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { filterSlashCommands, type SlashCommandItem } from "./slash-commands";
import { SlashMenuList, type SlashMenuListProps } from "./slash-menu-list";
import { isInTableCell } from "./table-cells";

/**
 * Whether a `/` typed at `range` starts a slash command: only at the start of a block or after whitespace, and never
 * in code, where a slash is ordinary text, or in a table cell, which holds text only.
 */
function canOpenAt(state: EditorState, range: Range) {
  const $from = state.doc.resolve(range.from);
  if ($from.parent.type.spec.code) return false;
  if (isInTableCell($from)) return false;
  const code = state.schema.marks.code;
  if (code && state.doc.rangeHasMark(range.from, range.to, code)) return false;
  // Inline leaves such as hard breaks start a new line, so they count as whitespace.
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, " ");
  return before === "" || /\s/.test(before);
}

/**
 * Says whether the menu the editor can open with `/` is showing. It is always on the editor, in both states, so
 * assistive technology can read the control's state before the menu has ever opened.
 */
function setExpanded(dom: HTMLElement, expanded: boolean) {
  dom.setAttribute("aria-expanded", String(expanded));
}

/** Points the editor at the listbox, and at the active option in it when there is one. */
function setControlled(dom: HTMLElement, listboxId: string, activeOptionId?: string) {
  dom.setAttribute("aria-controls", listboxId);
  if (activeOptionId) dom.setAttribute("aria-activedescendant", activeOptionId);
  else dom.removeAttribute("aria-activedescendant");
}

/**
 * Returns the editor to the state it has while the menu is closed: the listbox it pointed at is gone, so nothing is
 * controlled or active any more, and the caret stays in the editor.
 */
function setClosed(dom: HTMLElement) {
  dom.removeAttribute("aria-controls");
  dom.removeAttribute("aria-activedescendant");
  setExpanded(dom, false);
}

const preventFocusChange = (event: Event) => event.preventDefault();

let menuCount = 0;

/**
 * Renders the menu while a slash command is being typed. The menu is mounted inside the editor's dialog, because a
 * modal dialog blocks pointer events outside itself, or in the document body outside a dialog.
 */
function slashMenuRenderer(editor: Editor, pluginKey: PluginKey) {
  menuCount += 1;
  // Unique across editors, so two editors on a page never share option ids.
  const listboxId = `slash-menu-${menuCount}`;
  const optionId = (item: SlashCommandItem) => `${listboxId}-${item.id}`;
  let props: SuggestionProps<SlashCommandItem, SlashCommandItem> | undefined;
  let renderer: ReactRenderer<unknown, SlashMenuListProps> | undefined;
  let unmount: (() => void) | undefined;
  let query = "";
  let items: SlashCommandItem[] = [];
  let activeIndex = 0;

  const update = () => {
    renderer?.updateProps({ items, activeIndex });
    const dom = editor.view.dom;
    setExpanded(dom, true);
    const active = items[activeIndex];
    setControlled(dom, listboxId, active ? optionId(active) : undefined);
  };
  const activate = (index: number) => {
    if (index === activeIndex) return;
    activeIndex = index;
    update();
  };
  const select = (index: number) => {
    const item = items[index];
    if (item) props?.command(item);
  };
  const filter = (next: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
    props = next;
    if (next.query === query && renderer) return;
    query = next.query;
    items = filterSlashCommands(query);
    activeIndex = 0;
  };
  const close = () => exitSuggestion(editor.view, pluginKey);

  return {
    onStart(next: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      filter(next);
      renderer = new ReactRenderer(SlashMenuList, {
        editor,
        className: "slash-menu",
        props: { listboxId, items, activeIndex, optionId, onActivate: activate, onSelect: select },
      });
      const { element } = renderer;
      // Choosing an option with the mouse must leave focus, and the caret, in the editor.
      element.addEventListener("pointerdown", preventFocusChange);
      element.addEventListener("mousedown", preventFocusChange);
      // Suggestion's `container` option is one selector or element for every editor, so the menu is placed here
      // instead. `mount` then leaves the element where it is and only positions it, anchored to the slash query.
      (editor.view.dom.closest('[role="dialog"]') ?? document.body).append(element);
      unmount = next.mount(element);
      editor.on("blur", close);
      update();
    },
    onUpdate(next: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      filter(next);
      update();
    },
    onKeyDown({ event }: { event: KeyboardEvent }) {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.key === "Escape" || event.key === "Esc") {
        // `@tiptap/suggestion` closes the menu on Escape whatever this returns. Focus belongs to the editor, where the
        // caret is: it is put back explicitly rather than left wherever it happened to be, which for a reader is
        // `document.body`, with no caret to return to. A second Escape then leaves the editor, and a third closes the
        // dialog around it.
        editor.view.focus();
        return true;
      }
      // Without a match, Enter and the arrow keys keep their usual meaning in the editor.
      if (!items.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        activate((activeIndex + step + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        select(activeIndex);
        return true;
      }
      return false;
    },
    onExit() {
      editor.off("blur", close);
      unmount?.();
      renderer?.destroy();
      setClosed(editor.view.dom);
      props = undefined;
      renderer = undefined;
      unmount = undefined;
      query = "";
    },
  };
}

/**
 * Opens a menu of blocks when `/` is typed at the start of a block or after a space. Typing filters it, the arrow keys
 * and Enter choose a block, and Escape closes it.
 *
 * It keeps the default priority: extensions with a higher priority handle keys first, so the menu claims Enter, the
 * arrow keys, and Escape before the editor's own lower-priority shortcuts, such as Escape to leave the editor. Inside a
 * dialog that prevents Escape, `PreventedEscape` passes the key to them in the same order.
 */
export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey("slashCommand");
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        pluginKey,
        editor: this.editor,
        char: "/",
        // canOpenAt checks the character before the slash, including across marks, which the default prefix check
        // cannot see.
        allowedPrefixes: null,
        allow: ({ state, range }) => canOpenAt(state, range),
        command: ({ editor, range, props }) => {
          props.run(editor, range);
        },
        // Positioned with Floating UI. Fixed positioning resolves against the dialog when the dialog is transformed,
        // and against the viewport otherwise, so the menu stays at the caret in both places. The built-in flip is
        // replaced by flip and shift with padding, which keep the menu inside the dialog's clipped bounds.
        flip: false,
        floatingUi: { strategy: "fixed", middleware: [flip({ padding: 8 }), shift({ padding: 8 })] },
        render: () => slashMenuRenderer(this.editor, pluginKey),
      }),
      // What `/` opens, and whether it is open, is on the editor from the start, so a reader hears it before the menu
      // has ever been opened rather than only while it is showing.
      new Plugin({
        key: new PluginKey("slashMenuControl"),
        view(view) {
          const dom = view.dom;
          dom.setAttribute("aria-haspopup", "listbox");
          dom.setAttribute("aria-autocomplete", "list");
          setExpanded(dom, false);
          return {
            destroy: () => {
              dom.removeAttribute("aria-haspopup");
              dom.removeAttribute("aria-autocomplete");
              dom.removeAttribute("aria-expanded");
              setClosed(dom);
            },
          };
        },
      }),
    ];
  },
});
