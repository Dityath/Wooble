import { type AnyExtension, type EditorOptions, Extension } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { safeDocumentationUrl } from "./markdown-content";
import {
  createDocumentationMarked,
  DocumentationCodeBlock,
  DocumentationBareUrl,
  DocumentationMarkdown,
  DocumentationTable,
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
 * Drops a link mark whose destination documentation may not link to, such as `javascript:alert(1)` from a pasted
 * `[click me](javascript:alert(1))`, leaving the text it was written on. TipTap's `isAllowedUri` guards the paths it owns
 * (a pasted HTML anchor, a typed URL, `setLink`) and renders any other destination with an empty `href`, but its Markdown
 * parser reads a link destination as it was written, so the parsed Markdown is checked here.
 */
const DocumentationLinkSafety = Extension.create({
  name: "documentationLinkSafety",

  addProseMirrorPlugins() {
    const link = this.editor.schema.marks.link;
    if (!link) return [];
    return [
      new Plugin({
        key: new PluginKey("documentationLinkSafety"),
        appendTransaction: (transactions, _state, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            for (const mark of node.marks) {
              if (mark.type !== link) continue;
              const { href } = mark.attrs;
              if (typeof href !== "string" || !href || safeDocumentationUrl(href)) continue;
              tr.removeMark(pos, pos + node.nodeSize, mark);
            }
          });
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

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
        // Documentation links to `http`, `https` and `mailto` only (see `safeDocumentationUrl`, which the read-only
        // renderer applies too). This decides what a pasted HTML anchor, a typed URL, and `setLink` may link to.
        isAllowedUri: (url) => !url || safeDocumentationUrl(url) !== "",
        // Only text that is clearly a link: a URL with its scheme, a www. address, or an email address. File names such as
        // README.md or deploy.sh are also valid domain names and would otherwise link to someone else's site. A scheme
        // on its own is not enough: any `scheme://` would read `javascript:` and `data:` as a link too.
        shouldAutoLink: (url) =>
          (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && safeDocumentationUrl(url) !== "") ||
          /^www\./i.test(url) ||
          /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url),
      },
      // Replaced below by versions that write Markdown which reopens as the same blocks.
      paragraph: false,
      codeBlock: false,
      // Replaced below by a divider whose `---` shortcut does nothing in a table cell.
      horizontalRule: false,
    }),
    DocumentationBareUrl,
    DocumentationParagraph,
    DocumentationCodeBlock,
    DocumentationHorizontalRule,
    TaskList,
    TaskItem.configure({ nested: true }),
    // Table cells hold text only, as in Markdown (see table-cells.ts).
    TableKit.configure({ table: false, tableCell: false, tableHeader: false }),
    DocumentationTable.configure({ resizable: false }),
    DocumentationTableCell,
    DocumentationTableHeader,
    TableCellText,
    // Each editor gets its own Markdown parser, so editors opened one after another do not add to a shared one.
    DocumentationMarkdown.configure({ marked: createDocumentationMarked() }),
    Placeholder.configure({ placeholder: ({ editor }) => (editor.isEmpty ? placeholder : "") }),
    SlashCommand,
    MarkdownPaste,
    DocumentationLinkSafety,
    PreventedEscape,
  ];
}
