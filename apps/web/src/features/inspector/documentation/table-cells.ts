import { Extension, InputRule } from "@tiptap/core";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { TableCell, TableHeader } from "@tiptap/extension-table";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { __pastedCells as pastedCells, CellSelection } from "@tiptap/pm/tables";

// A Markdown table cell holds one line of inline content, so a cell takes paragraphs only (saved joined by <br>).
// Lists, headings, quotes, code, dividers, and nested tables in a cell could not be saved.
export const DocumentationTableCell = TableCell.extend({ content: "paragraph+" });
export const DocumentationTableHeader = TableHeader.extend({ content: "paragraph+" });

/** Whether `$pos` is inside a table cell or header cell. */
export function isInTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

/** Whether text goes into a single cell: the caret or a text selection in a cell, not a selection of whole cells. */
export function isTypingInTableCell(state: EditorState): boolean {
  return !(state.selection instanceof CellSelection) && isInTableCell(state.selection.$from);
}

/**
 * Returns the text of `slice` as paragraphs, one for each paragraph, heading, list item, table cell, or code line,
 * keeping its inline formatting. A block that a cell cannot hold would otherwise make ProseMirror close the table,
 * insert the block after it, and open a new table for the rest of the row. Inline content, such as part of a sentence
 * copied from a web page, fits in a cell as it is.
 */
export function asCellText(slice: Slice, paragraph: ProseMirrorNode["type"]): Slice {
  let inlineOnly = true;
  slice.content.forEach((node) => {
    if (!node.isInline) inlineOnly = false;
  });
  if (inlineOnly) return slice;

  const paragraphs: ProseMirrorNode[] = [];
  let inline: ProseMirrorNode[] = [];
  const endLine = () => {
    if (inline.length) paragraphs.push(paragraph.create(null, inline));
    inline = [];
  };
  const collect = (content: Fragment) =>
    content.forEach((node) => {
      if (node.isInline) {
        inline.push(node);
        return;
      }
      endLine();
      if (node.type.spec.code) {
        for (const line of node.textContent.split("\n"))
          paragraphs.push(paragraph.create(null, line ? node.type.schema.text(line) : null));
      } else if (node.isTextblock) {
        paragraphs.push(paragraph.create(null, node.content));
      } else {
        collect(node.content);
      }
    });
  collect(slice.content);
  endLine();
  // Open at both ends, so the first and last lines join the text around the caret.
  return paragraphs.length ? new Slice(Fragment.from(paragraphs), 1, 1) : Slice.empty;
}

/** Whether `slice` is table rows or cells, which the table extension pastes into the cells they cover. */
const isTableCells = (slice: Slice) => pastedCells(slice) !== null;

/**
 * Keeps content pasted or dropped into a table cell to text, so that it cannot split the table (see `asCellText`).
 * Pasted rows and cells are left to the table extension.
 */
export const TableCellText = Extension.create({
  name: "tableCellText",

  addProseMirrorPlugins() {
    // ProseMirror also passes dropped content through transformPasted, while the selection is still where the drag
    // started. Drops are left to handleDrop, which looks at where they land.
    let dropping = false;
    return [
      new Plugin({
        key: new PluginKey("tableCellText"),
        props: {
          handleDOMEvents: {
            // Runs before ProseMirror handles the drop, which it does before the event returns.
            drop: () => {
              dropping = true;
              queueMicrotask(() => {
                dropping = false;
              });
              return false;
            },
          },
          // A paste goes to the selection.
          transformPasted: (slice, view) =>
            !dropping && isTypingInTableCell(view.state) && !isTableCells(slice)
              ? asCellText(slice, view.state.schema.nodes.paragraph)
              : slice,
          // A drop goes to the pointer, which may be in a cell while the selection (what is dragged) is not.
          handleDrop: (view, event, slice, moved) => {
            const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!target || !isInTableCell(view.state.doc.resolve(target.pos)) || isTableCells(slice)) return false;
            const text = asCellText(slice, view.state.schema.nodes.paragraph);
            // Nothing in it is text, such as a dragged divider: drop nothing, and keep what was dragged.
            if (!text.size) return true;
            const tr = view.state.tr;
            if (moved) tr.deleteSelection();
            const pos = tr.mapping.map(target.pos);
            tr.replaceRange(pos, pos, text);
            const end = tr.mapping.maps[tr.mapping.maps.length - 1].map(pos, 1);
            tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
            view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "drop"));
            // After dispatching: TipTap answers focus with a transaction of its own.
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});

/** Dividers whose `---` shortcut leaves the text alone in a table cell, which cannot hold a divider. */
export const DocumentationHorizontalRule = HorizontalRule.extend({
  addInputRules() {
    return (this.parent?.() ?? []).map(
      (rule) =>
        new InputRule({
          find: rule.find,
          undoable: rule.undoable,
          handler: (props) => (isInTableCell(props.state.selection.$from) ? null : rule.handler(props)),
        }),
    );
  },
});
