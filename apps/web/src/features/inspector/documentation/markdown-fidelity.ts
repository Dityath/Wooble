import { Extension, type JSONContent } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Table } from "@tiptap/extension-table";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Markdown } from "@tiptap/markdown";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { Marked, type marked, Tokenizer } from "marked";

/**
 * Returns `content` with the least change that makes it valid for `schema`. TipTap's Markdown parser can produce
 * content the schema does not allow, such as the alt text of a standalone image (`![Diagram](x.png)`) directly in the
 * document, or a numbered list item without a paragraph (`2.` with no text). ProseMirror does not check the content it
 * is given, and later edits next to an invalid node fail.
 *
 * Inline content in a block container is wrapped in a paragraph, required nodes that are missing are filled in, and a
 * node that only fits inside a wrapper (a paragraph directly in a list) is wrapped. Content that still does not fit is
 * kept as it is rather than dropped.
 */
export function fitToSchema(content: JSONContent, schema: Schema): JSONContent {
  let node: ProseMirrorNode;
  try {
    node = schema.nodeFromJSON(content);
  } catch {
    // Unknown node types: leave the content to TipTap, which reports invalid content itself.
    return content;
  }
  return fitNode(node, schema).toJSON();
}

function fitNode(node: ProseMirrorNode, schema: Schema): ProseMirrorNode {
  if (node.isTextblock || node.isLeaf) return node;
  const children: ProseMirrorNode[] = [];
  let inline: ProseMirrorNode[] = [];
  const wrapInline = () => {
    if (inline.length) children.push(schema.nodes.paragraph.create(null, inline));
    inline = [];
  };
  node.forEach((child) => {
    if (child.isInline) {
      inline.push(child);
      return;
    }
    wrapInline();
    children.push(fitNode(child, schema));
  });
  wrapInline();

  const fitted: ProseMirrorNode[] = [];
  let match = node.type.contentMatch;
  for (let child of children) {
    let next = match.matchType(child.type);
    if (!next) {
      const missing = match.fillBefore(Fragment.from(child));
      if (missing?.size) {
        missing.forEach((filler) => {
          fitted.push(filler);
        });
        match = match.matchFragment(missing) ?? match;
        next = match.matchType(child.type);
      }
    }
    if (!next) {
      const wrappers = match.findWrapping(child.type);
      if (wrappers?.length) {
        child = wrappers.reduceRight((inner, wrapper) => wrapper.create(null, inner), child);
        next = match.matchType(child.type);
      }
    }
    fitted.push(child);
    if (next) match = next;
  }
  const end = match.fillBefore(Fragment.empty, true);
  end?.forEach((filler) => {
    fitted.push(filler);
  });
  return node.type.create(node.attrs, fitted, node.marks);
}

/**
 * Backslash-escapes text at the start of each line of a rendered paragraph that Markdown would read as the start of
 * another block: an ATX heading (`# `), a bullet (`- `, `+ `), a numbered item (`1. `, `1) `), or a thematic break or
 * setext underline (`---`, `===`). Leading spaces are removed, because Markdown drops them from a paragraph line and
 * four of them would start a code block. TipTap already escapes inline syntax (`*`, `_`, `` ` ``, `[`, `~`) and encodes
 * `<` and `>`.
 *
 * Without this, a paragraph such as `1. not a list` or `\# Literal` would reopen as a list or a heading.
 */
export function escapeBlockSyntax(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      line
        .replace(/^[ \t]+/, "")
        .replace(/^#(?=#{0,5}(?:[ \t]|$))/, "\\#")
        .replace(/^([-+])(?=[ \t]|$)/, "\\$1")
        .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2")
        .replace(/^([-=])(?=[-= \t]*$)/, "\\$1"),
    )
    .join("\n");
}

/** Returns a backtick fence longer than any run of backticks in `code`, so the code cannot close its own block. */
export function codeFence(code: string): string {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), ([run]) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Paragraphs whose text could be read as another block when the Markdown is opened again. */
export const DocumentationParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, context) {
    return escapeBlockSyntax(this.parent?.(node, helpers, context) ?? "");
  },
});

/** Code blocks fenced so that code containing ``` (such as a Markdown sample) stays inside its block. */
export const DocumentationCodeBlock = CodeBlock.extend({
  renderMarkdown(node, helpers, context) {
    const code = helpers.renderChildren(node.content ?? []);
    const fence = codeFence(code);
    if (fence === "```") return this.parent?.(node, helpers, context) ?? "";
    return `${fence}${node.attrs?.language ?? ""}\n${code}\n${fence}`;
  },
});

/** Compact GFM tables keep a long cell from padding every other row past the API limit. */
export const DocumentationTable = Table.extend({
  renderMarkdown(node, helpers) {
    const rows = node.content ?? [];
    if (!rows.length) return "";
    const renderRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const lines = rows.map((row) =>
      renderRow(
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((child) => helpers.renderChildren(child))
            .join("\n")
            .replace(/[ \t]*\r?\n[ \t]*/g, "<br>")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\\.|\|/g, (match) => (match === "|" ? "\\|" : match)),
        ),
      ),
    );
    const alignment = (rows[0].content ?? []).map((cell) => {
      const align = cell.attrs?.align ?? cell.attrs?.textAlign;
      return align === "left" ? ":---" : align === "right" ? "---:" : align === "center" ? ":---:" : "---";
    });
    lines.splice(1, 0, renderRow(alignment));
    return `\n${lines.join("\n")}\n`;
  },
});

const urlParser = new Marked();
/** Only omit link syntax when GFM reads the entire destination as the same link. */
function isBareUrl(href: unknown): href is string {
  if (typeof href !== "string" || !/^https?:\/\//.test(href)) return false;
  const tokens = urlParser.Lexer.lexInline(href, { gfm: true });
  return tokens.length === 1 && tokens[0].type === "link" && tokens[0].raw === href && tokens[0].href === href;
}

/** Serialization-only node: never inserted into the editor schema or persisted JSON. */
export const DocumentationBareUrl = Extension.create({
  name: "documentationBareUrl",
  renderMarkdown: (node) => node.attrs?.href ?? "",
});

// TipTap decodes these named references, and numeric ones, itself. Decoding them here too would decode `&amp;lt;`
// twice and turn the literal text `&lt;` into `<`.
const referencesDecodedByTipTap = new Set(["amp", "lt", "gt", "quot"]);

/**
 * Decodes named character references such as `&copy;`, `&rarr;`, and `&nbsp;`, which Markdown text may use and TipTap's
 * parser keeps as literal text. Saving that text would then write `&amp;copy;`, so the reading view would show
 * `&copy;` instead of ©. Unknown names are kept as they are.
 */
export function decodeNamedReferences(text: string): string {
  return text.replace(/&([A-Za-z][A-Za-z0-9]{0,31});/g, (reference, name: string) => {
    if (referencesDecodedByTipTap.has(name)) return reference;
    const decoded = decodeNamedCharacterReference(name);
    if (decoded === false) return reference;
    // TipTap decodes `&amp;` afterwards, so a decoded `&` (from `&AMP;`) is written as `&amp;` to stay one `&`.
    return decoded.replaceAll("&", "&amp;");
  });
}

/** Tokenizes Markdown as marked does, then decodes named references in text (but not in code, which is literal). */
class DocumentationTokenizer extends Tokenizer {
  inlineText(src: string) {
    const token = super.inlineText(src);
    if (token) token.text = decodeNamedReferences(token.text);
    return token;
  }
}

/**
 * Returns a Markdown parser for one editor, which decodes named references in text (see `decodeNamedReferences`).
 * TipTap registers its Markdown tokenizers with the parser each time an editor is created, so a parser shared by every
 * editor, such as marked's default, would collect them again for each documentation opened.
 */
export function createDocumentationMarked(): typeof marked {
  const parser = new Marked();
  parser.setOptions({ tokenizer: new DocumentationTokenizer() });
  // TipTap types the parser as marked's default export, but only uses what every Marked instance has: Lexer,
  // defaults, lexer, setOptions, and use.
  return parser as unknown as typeof marked;
}

/**
 * The Markdown extension, with everything it parses fitted to the editor's schema (see `fitToSchema`). Configure it with
 * `marked: createDocumentationMarked()`.
 */
export const DocumentationMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const { editor } = this;
    const manager = editor.markdown;
    if (!manager) return;
    // Every Markdown entry point (initial content, setContent, insertContent) parses through the manager.
    // TipTap escapes link text even when delimiters are omitted. Render a complete plain URL through a temporary
    // serialization-only node so underscores and query ampersands stay literal. Split/formatted/titled links keep
    // the ordinary link serializer. The editor document itself is never changed.
    const renderNodes = manager.renderNodes.bind(manager);
    manager.renderNodes = (nodes, ...args) => {
      const plainUrl = (node: JSONContent, index = 0): JSONContent => {
        const link = node.marks?.length === 1 && node.marks[0].type === "link" ? node.marks[0] : undefined;
        if (node.type !== "text" || link?.attrs?.title || node.text !== link?.attrs?.href || !isBareUrl(node.text))
          return node;
        const next = Array.isArray(nodes) ? nodes[index + 1] : undefined;
        // Adjacent text such as `/other` must not silently extend an explicitly delimited link's destination.
        const nextText = next?.type === "text" ? (next.text ?? "") : "";
        if (nextText && urlParser.Lexer.lexInline(`${node.text}${nextText}`, { gfm: true })[0]?.raw !== node.text)
          return node;
        return { type: "documentationBareUrl", attrs: { href: node.text } };
      };
      return renderNodes(Array.isArray(nodes) ? nodes.map(plainUrl) : plainUrl(nodes), ...args);
    };
    const parse = manager.parse.bind(manager);
    manager.parse = (markdown) => fitToSchema(parse(markdown), editor.schema);
    // The parent extension has already parsed the initial content before parse could be wrapped.
    const { content } = editor.options;
    if (content && typeof content === "object" && !Array.isArray(content))
      editor.options.content = fitToSchema(content as JSONContent, editor.schema);
  },
});
