import type { ChainedCommands, Editor, Range } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  Minus,
  Pilcrow,
  Quote,
  SquareCode,
  Table,
} from "lucide-react";

/** A block the slash menu can insert at the caret. */
export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  /** Other words that find the command, such as Markdown names (`h1`, `hr`). */
  keywords: string[];
  icon: LucideIcon;
  /** Deletes the `/query` text in `range`, then inserts this command's block at the caret. */
  run(editor: Editor, range: Range): boolean;
}

/** The text of `block` before the caret at `offset` and after the `query` characters that start at that offset. */
function textAround(block: Node, offset: number, query: number) {
  // Inline leaves such as hard breaks count as text, so a block that holds only one of them is not an empty block.
  return {
    before: block.textBetween(0, offset, undefined, " "),
    after: block.textBetween(offset + query, block.content.size, undefined, " "),
  };
}

/** Whether the caret block in `range` holds text other than the slash query, which the command has to keep. */
function holdsText(state: EditorState, range: Range) {
  const $from = state.doc.resolve(range.from);
  const { before, after } = textAround($from.parent, $from.parentOffset, range.to - range.from);
  return Boolean(before.trim() || after.trim());
}

/**
 * Leaves an empty block where the deleted query was, with the caret in it, so that the command turns that block and only
 * that block: text before the caret keeps the block it was in, and text after the caret moves into the block that
 * follows it. The query must already be deleted, so `caret` is where the query was.
 */
function openBlockAtCaret(tr: Transaction, caret: number) {
  const $caret = tr.doc.resolve(caret);
  const { before, after } = textAround($caret.parent, $caret.parentOffset, 0);
  const empty = tr.doc.type.schema.nodes.paragraph.create();
  if (!before.trim()) {
    // Nothing but spaces precedes the caret, so the new block goes before the block the caret is in, which keeps the
    // text after it.
    const start = $caret.before();
    tr.insert(start, empty);
    tr.setSelection(TextSelection.create(tr.doc, start + 1));
    return;
  }
  // The block that follows the split starts where the caret was, once past its opening token, so the text after the
  // caret starts one position further in again.
  tr.split(caret, 1);
  if (after.trim()) tr.insert(caret + 1, empty);
  tr.setSelection(TextSelection.create(tr.doc, caret + 2));
}

/** Deletes the slash query, then applies `transform` to the block left at the caret, in the same transaction. */
function turnInto(transform: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range) => transform(editor.chain().focus().deleteRange(range)).run();
}

/**
 * Deletes the slash query, then applies `transform` to a new empty block at the caret, so that the text around the
 * caret survives. A caret block that holds nothing but the query, which is the case on a blank line, is the block the
 * command turns, as it always was.
 *
 * Opening the block and turning it are two transactions: TipTap's commands read positions from the state they are given,
 * and one that has already opened the block has them shifted. Both are dispatched together, so the history keeps them in
 * one undo step, and the first announces no change, so the document is saved once, when the command has finished.
 */
function insertAtCaret(transform: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range) => {
    if (!holdsText(editor.state, range)) return turnInto(transform)(editor, range);
    const opened = editor.state.tr.delete(range.from, range.to);
    openBlockAtCaret(opened, range.from);
    editor.view.dispatch(opened.setMeta("preventUpdate", true));
    return transform(editor.chain().focus()).run();
  };
}

/** Deletes the slash query and leaves the caret where it was, so the block around it is untouched. */
function deleteQuery(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range).run();
}

/**
 * Inserts a list or quote at the caret, unless the caret is already in one: the toggle commands would unwrap it
 * instead, and a slash command never removes the block type it names, so there only the query goes.
 */
function wrapUnlessActive(name: string, wrap: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range) => {
    if (editor.isActive(name)) return deleteQuery(editor, range);
    return insertAtCaret(wrap)(editor, range);
  };
}

export const slashCommands: SlashCommandItem[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph text",
    keywords: ["paragraph", "plain", "body"],
    icon: Pilcrow,
    run: insertAtCaret((chain) => chain.setParagraph()),
  },
  {
    id: "heading-1",
    title: "Heading 1",
    description: "Large section heading",
    keywords: ["h1", "title"],
    icon: Heading1,
    run: insertAtCaret((chain) => chain.setHeading({ level: 1 })),
  },
  {
    id: "heading-2",
    title: "Heading 2",
    description: "Medium section heading",
    keywords: ["h2", "subtitle"],
    icon: Heading2,
    run: insertAtCaret((chain) => chain.setHeading({ level: 2 })),
  },
  {
    id: "heading-3",
    title: "Heading 3",
    description: "Small section heading",
    keywords: ["h3", "subheading"],
    icon: Heading3,
    run: insertAtCaret((chain) => chain.setHeading({ level: 3 })),
  },
  {
    id: "bulleted-list",
    title: "Bulleted list",
    description: "A list with bullet points",
    keywords: ["bullet", "unordered", "ul"],
    icon: List,
    run: wrapUnlessActive("bulletList", (chain) => chain.toggleBulletList()),
  },
  {
    id: "numbered-list",
    title: "Numbered list",
    description: "A list with numbered steps",
    keywords: ["ordered", "number", "ol"],
    icon: ListOrdered,
    run: wrapUnlessActive("orderedList", (chain) => chain.toggleOrderedList()),
  },
  {
    id: "task-list",
    title: "Task list",
    description: "Track tasks with checkboxes",
    keywords: ["todo", "checkbox", "check"],
    icon: ListTodo,
    run: wrapUnlessActive("taskList", (chain) => chain.toggleTaskList()),
  },
  {
    id: "quote",
    title: "Quote",
    description: "Set text apart as a quotation",
    keywords: ["blockquote", "cite"],
    icon: Quote,
    run: wrapUnlessActive("blockquote", (chain) => chain.toggleBlockquote()),
  },
  {
    id: "code-block",
    title: "Code block",
    description: "Code in a monospace block",
    keywords: ["code", "snippet", "fence", "pre"],
    icon: SquareCode,
    run: insertAtCaret((chain) => chain.setCodeBlock()),
  },
  {
    id: "divider",
    title: "Divider",
    description: "A line between sections",
    keywords: ["horizontal", "rule", "hr", "separator", "line"],
    icon: Minus,
    run: insertAtCaret((chain) => chain.setHorizontalRule()),
  },
  {
    id: "table",
    title: "Table",
    description: "Insert a 3 × 3 table with a header row",
    keywords: ["grid", "rows", "columns"],
    icon: Table,
    run: insertAtCaret((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
  },
];

/**
 * Returns the commands whose title or a keyword contains `query`, ignoring case and surrounding spaces. Titles that
 * start with the query come first; otherwise the declared order is kept. An empty query returns every command.
 */
export function filterSlashCommands(query: string, commands: SlashCommandItem[] = slashCommands): SlashCommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  const matches = commands.filter(
    ({ title, keywords }) =>
      title.toLowerCase().includes(needle) || keywords.some((keyword) => keyword.toLowerCase().includes(needle)),
  );
  const startsWithQuery = matches.filter(({ title }) => title.toLowerCase().startsWith(needle));
  return [...startsWithQuery, ...matches.filter((command) => !startsWithQuery.includes(command))];
}
