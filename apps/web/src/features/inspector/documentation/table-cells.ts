import { Extension, InputRule } from "@tiptap/core";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { TableCell, TableHeader } from "@tiptap/extension-table";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

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

/** Whether `content` holds table structure, which the table extension pastes into the cells itself. */
function hasTableStructure(content: Fragment): boolean {
  let found = false;
  content.descendants((node) => {
    if (node.type.spec.tableRole) found = true;
    return !found;
  });
  return found;
}

/**
 * Returns the text of `slice` as paragraphs, one for each paragraph, heading, list item, or code line, keeping its
 * inline formatting. A block that a cell cannot hold would otherwise make ProseMirror close the table, insert the block
 * after it, and open a new table for the rest of the row.
 */
export function asCellText(slice: Slice, paragraph: ProseMirrorNode["type"]): Slice {
  const paragraphs: ProseMirrorNode[] = [];
  slice.content.descendants((node) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) {
      for (const line of node.textContent.split("\n"))
        paragraphs.push(paragraph.create(null, line ? node.type.schema.text(line) : null));
    } else {
      paragraphs.push(paragraph.create(null, node.content));
    }
    return false;
  });
  // Open at both ends, so the first and last lines join the text around the caret.
  return paragraphs.length ? new Slice(Fragment.from(paragraphs), 1, 1) : Slice.empty;
}

/**
 * Keeps content pasted or dropped into a table cell to text, so that it cannot split the table (see `asCellText`).
 * Pasted table cells are left to the table extension, which fills the cells they cover.
 */
export const TableCellText = Extension.create({
  name: "tableCellText",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tableCellText"),
        props: {
          transformPasted: (slice, view) =>
            isTypingInTableCell(view.state) && !hasTableStructure(slice.content)
              ? asCellText(slice, view.state.schema.nodes.paragraph)
              : slice,
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
