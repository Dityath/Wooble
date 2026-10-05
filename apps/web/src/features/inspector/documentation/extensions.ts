import type { AnyExtension, EditorOptions } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { StarterKit } from "@tiptap/starter-kit";
import { DocumentationCodeBlock, DocumentationMarkdown, DocumentationParagraph } from "./markdown-fidelity";
import { MarkdownPaste } from "./markdown-paste";
import { SlashCommand } from "./slash-menu";

/** Editor options for the documentation editor, used together with `documentationExtensions`. */
export const documentationEditorOptions = {
  // Markdown pasted as plain text is converted by MarkdownPaste, which leaves prose such as `2 * 3 * 4` or `snake_case`
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
      // A plain click places the caret; opening the link would take the user away while they edit.
      link: { openOnClick: false },
      // Replaced below by versions that write Markdown which reopens as the same blocks.
      paragraph: false,
      codeBlock: false,
    }),
    DocumentationParagraph,
    DocumentationCodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    DocumentationMarkdown,
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? placeholder : "") }),
    SlashCommand,
    MarkdownPaste,
  ];
}
