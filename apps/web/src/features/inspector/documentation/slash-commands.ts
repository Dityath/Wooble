import type { ChainedCommands, Editor, Range } from "@tiptap/core";
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

/** A block the slash menu can turn the current block into. */
export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  /** Other words that find the command, such as Markdown names (`h1`, `hr`). */
  keywords: string[];
  icon: LucideIcon;
  /** Deletes the `/query` text in `range`, then turns the block at the caret into this command's block. */
  run(editor: Editor, range: Range): boolean;
}

/** Deletes the slash query, then applies `transform` in the same transaction. */
function turnInto(transform: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range) => transform(editor.chain().focus().deleteRange(range)).run();
}

/**
 * Wraps the block in a list or quote, unless it is already in one: the toggle commands would unwrap it instead, and a
 * slash command never removes the block type it names.
 */
function wrapUnlessActive(name: string, wrap: (chain: ChainedCommands) => ChainedCommands) {
  return (editor: Editor, range: Range) => {
    const isActive = editor.isActive(name);
    return turnInto((chain) => (isActive ? chain : wrap(chain)))(editor, range);
  };
}

export const slashCommands: SlashCommandItem[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph text",
    keywords: ["paragraph", "plain", "body"],
    icon: Pilcrow,
    run: turnInto((chain) => chain.setParagraph()),
  },
  {
    id: "heading-1",
    title: "Heading 1",
    description: "Large section heading",
    keywords: ["h1", "title"],
    icon: Heading1,
    run: turnInto((chain) => chain.setHeading({ level: 1 })),
  },
  {
    id: "heading-2",
    title: "Heading 2",
    description: "Medium section heading",
    keywords: ["h2", "subtitle"],
    icon: Heading2,
    run: turnInto((chain) => chain.setHeading({ level: 2 })),
  },
  {
    id: "heading-3",
    title: "Heading 3",
    description: "Small section heading",
    keywords: ["h3", "subheading"],
    icon: Heading3,
    run: turnInto((chain) => chain.setHeading({ level: 3 })),
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
    run: turnInto((chain) => chain.setCodeBlock()),
  },
  {
    id: "divider",
    title: "Divider",
    description: "A line between sections",
    keywords: ["horizontal", "rule", "hr", "separator", "line"],
    icon: Minus,
    run: turnInto((chain) => chain.setHorizontalRule()),
  },
  {
    id: "table",
    title: "Table",
    description: "Insert a 3 × 3 table with a header row",
    keywords: ["grid", "rows", "columns"],
    icon: Table,
    run: turnInto((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
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
