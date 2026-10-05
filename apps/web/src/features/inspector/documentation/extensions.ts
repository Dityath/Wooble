import type { AnyExtension, EditorOptions } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { StarterKit } from "@tiptap/starter-kit";
import {
  createDocumentationMarked,
  DocumentationCodeBlock,
  DocumentationMarkdown,
  DocumentationParagraph,
} from "./markdown-fidelity";
import { MarkdownPaste } from "./markdown-paste";
import { PreventedEscape } from "./prevented-escape";
import { SlashCommand } from "./slash-menu";
import {
  DocumentationHorizontalRule,
  DocumentationTableCell,
  DocumentationTableHeader,
  TableCellText,
} from "./table-cells";

/** Editor options for the documentation editor, used together with `documentationExtensions`. */
export const documentationEditorOptions = {
  // Markdown pasted as plain text is converted by MarkdownPaste, which leaves text such as `2 * 3 * 4` or `snake_case`
  // alone. The mark paste rules would still turn `* 3 *` or `_word_` in any pasted text into italics, so pasted text is
  // only scanned for links.
  enablePasteRules: ["link"],
} satisfies Partial<EditorOptions>;

export interface DocumentationExtensionOptions {
  placeholder?: string;
}

/**
 * The documentation editor's extensions. Documentation is stored as Markdown, so every block and mark they enable has
 * a Markdown form.
 */
export function documentationExtensions({ placeholder = "" }: DocumentationExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Markdown has no underline syntax, so underlined text could not be saved.
      underline: false,
      link: {
        // A plain click places the caret; opening the link would take the user away while they edit.
        openOnClick: false,
        // Only text that is clearly a link: a URL with its scheme, a www. address, or an email address. File names such as
        // README.md or deploy.sh are also valid domain names and would otherwise link to someone else's site.
        shouldAutoLink: (url) =>
          /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^www\./i.test(url) || /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url),
      },
      // Replaced below by versions that write Markdown which reopens as the same blocks.
      paragraph: false,
      codeBlock: false,
      // Replaced below by a divider whose `---` shortcut does nothing in a table cell.
      horizontalRule: false,
    }),
    DocumentationParagraph,
    DocumentationCodeBlock,
    DocumentationHorizontalRule,
    TaskList,
    TaskItem.configure({ nested: true }),
    // Table cells hold text only, as in Markdown (see table-cells.ts).
    TableKit.configure({ table: { resizable: false }, tableCell: false, tableHeader: false }),
    DocumentationTableCell,
    DocumentationTableHeader,
    TableCellText,
    // Each editor gets its own Markdown parser, so editors opened one after another do not add to a shared one.
    DocumentationMarkdown.configure({ marked: createDocumentationMarked() }),
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? placeholder : "") }),
    SlashCommand,
    MarkdownPaste,
    PreventedEscape,
  ];
}
