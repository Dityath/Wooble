import { type Editor, Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { CellSelection, isInTable } from "@tiptap/pm/tables";

/** Markdown blocks that a line can start: each needs its marker at the start of the line, as Markdown does. */
const blockSyntax = [
  // An ATX heading (`# Title`), but not `#tag`, `#1`, or `C#`.
  /^ {0,3}#{1,6}[ \t]+\S/,
  // A bullet, task item, or numbered item (`- x`, `- [ ] x`, `1. x`, `2) x`), but not `a - b`, `-1`, or `1.5 million`.
  /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/,
  // A quote (`> x`, `> > x`), but not `>5`.
  /^ {0,3}>(?:[ \t]*>)*[ \t]+\S/,
  // A code fence.
  /^ {0,3}(?:```|~~~)/,
  // A thematic break (`---`, `***`, `___`, `- - -`).
  /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
];

/**
 * Inline Markdown that prose rarely contains by accident. Single `*` and `_` emphasis is left out because ordinary text
 * such as `2 * 3 * 4` or `snake_case_name` uses those characters.
 */
const inlineSyntax = [
  // **bold**, but not `2 ** 3`.
  /\*\*\S(?:.*?\S)?\*\*/,
  // __bold__, but not `snake__case__name`.
  /(?<![\p{L}\p{N}_])__\S(?:.*?\S)?__(?![\p{L}\p{N}_])/u,
  // `code`, but not backticks used as apostrophes (`it`s`).
  /(?<![\p{L}\p{N}])`[^`]+`(?![\p{L}\p{N}])/u,
  // [text](url), with an optional title.
  /\[[^\]]+\]\([^\s)]+(?:\s+"[^"]*")?\)/,
  // ~~strikethrough~~
  /~~[^\s~](?:.*?[^\s~])?~~/,
];

const lineSyntax = [...blockSyntax, ...inlineSyntax];

/** A table's delimiter row (`| --- | :-: |`). */
const tableDelimiter = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/;

/** Returns the number of cells in a table row, not counting its outer pipes or escaped pipes. */
function cellCount(row: string): number {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/).length;
}

/**
 * Returns whether pasted plain text looks like Markdown: a line starts a Markdown block (a heading, list item, task
 * item, quote, code fence, thematic break, or table), or the text uses unambiguous inline syntax (`**bold**`,
 * `__bold__`, `` `code` ``, `[text](url)`, `~~struck~~`). Plain prose, a bare URL, and a single sentence do not.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r\n?|\n/);
  return lines.some((line, index) => {
    if (lineSyntax.some((syntax) => syntax.test(line))) return true;
    // A table's delimiter row follows a header row with as many cells.
    const header = lines[index - 1]?.trim();
    if (!header) return false;
    return tableDelimiter.test(line) && cellCount(header) === cellCount(line);
  });
}

/** VS Code language modes whose text can be Markdown. Code in any other mode is left to the code block's paste. */
const proseModes = new Set(["markdown", "plaintext"]);

/** Returns the language mode that VS Code records with copied text, if its editor data names one. */
function vscodeMode(editorData: string): string | undefined {
  try {
    const mode = JSON.parse(editorData)?.mode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the clipboard's plain text when it should be pasted as Markdown, or `null` to leave the paste to the default. */
function markdownToPaste(state: EditorState, clipboard: DataTransfer | null): string | null {
  const { selection } = state;
  // Text pasted into code stays literal, and the table pastes text into selected cells itself.
  if (!clipboard || selection.$from.parent.type.spec.code || selection instanceof CellSelection) return null;
  const vscodeData = clipboard.getData("vscode-editor-data");
  if (vscodeData) {
    // VS Code's HTML is its syntax highlighting, so its plain text is read instead. Code in another language is left
    // to the code block's VS Code paste, which keeps it as code.
    const mode = vscodeMode(vscodeData);
    if (mode && !proseModes.has(mode)) return null;
  } else if (clipboard.getData("text/html")) {
    // Rich text keeps its formatting through the default HTML paste.
    return null;
  }
  const text = clipboard.getData("text/plain");
  return looksLikeMarkdown(text) ? text : null;
}

/**
 * Replaces the selection with the content `markdown` describes, in one transaction so that one undo removes the paste.
 * Returns `false`, leaving the paste to the default, when that content cannot go at the selection.
 */
function pasteMarkdown(editor: Editor, markdown: string): boolean {
  // Parsed as `insertContent(markdown, { contentType: "markdown" })` would, and fitted to the schema, so that a single
  // paragraph can be told apart from blocks before it is inserted.
  const parsed = editor.markdown?.parse(markdown);
  const blocks = parsed?.content ?? [];
  // A single paragraph, such as `**bold**` or a link, joins the text at the caret instead of splitting its paragraph.
  const inline = blocks.length === 1 && blocks[0].type === "paragraph" ? blocks[0].content : undefined;
  if (inline?.length) return editor.chain().insertContent(inline).scrollIntoView().run();
  // A Markdown table cell holds only inline content, so blocks pasted into a cell could not be saved.
  if (!parsed || isInTable(editor.state)) return false;
  return editor.chain().insertContent(parsed).scrollIntoView().run();
}

/**
 * Pastes plain text that looks like Markdown (see `looksLikeMarkdown`) as the blocks and formatting it describes,
 * replacing the selection. Everything else is left to the default paste: text pasted into code, rich text (HTML) other
 * than a copy from VS Code, code copied from VS Code, a paste over selected table cells, blocks pasted into a table
 * cell, and plain text that does not look like Markdown.
 */
export const MarkdownPaste = Extension.create({
  name: "markdownPaste",
  // Ahead of the code block's VS Code paste and the plain-text numbered list paste (priority 100), so that Markdown
  // copied from VS Code or containing a numbered list is read as Markdown. The link paste (1000), which links a URL
  // pasted over selected text, still runs first; a bare URL does not look like Markdown.
  priority: 101,

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("markdownPaste"),
        props: {
          handlePaste: (view, event) => {
            const markdown = markdownToPaste(view.state, event.clipboardData);
            return markdown !== null && pasteMarkdown(editor, markdown);
          },
        },
      }),
    ];
  },
});
