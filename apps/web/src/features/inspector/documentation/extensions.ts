import type { AnyExtension } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { StarterKit } from "@tiptap/starter-kit";
import { DocumentationCodeBlock, DocumentationMarkdown, DocumentationParagraph } from "./markdown-fidelity";
import { MarkdownPaste } from "./markdown-paste";
import { SlashCommand } from "./slash-menu";

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
