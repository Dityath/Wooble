import type { JSONContent } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Markdown } from "@tiptap/markdown";
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";

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

/** The Markdown extension, with everything it parses fitted to the editor's schema (see `fitToSchema`). */
export const DocumentationMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const { editor } = this;
    const manager = editor.markdown;
    if (!manager) return;
    // Every Markdown entry point (initial content, setContent, insertContent) parses through the manager.
    const parse = manager.parse.bind(manager);
    manager.parse = (markdown) => fitToSchema(parse(markdown), editor.schema);
    // The parent extension has already parsed the initial content before parse could be wrapped.
    const { content } = editor.options;
    if (content && typeof content === "object" && !Array.isArray(content))
      editor.options.content = fitToSchema(content as JSONContent, editor.schema);
  },
});
