import { Marked } from "marked";

const parser = new Marked();

/** Inspect Markdown tokens so examples inside code and escaped syntax remain ordinary editable text. */
export function unsupportedMarkdown(markdown: string): string[] {
  const found = new Set<string>();
  if (/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(markdown))
    found.add("YAML front matter");
  const tokens = parser.lexer(markdown);
  parser.walkTokens(tokens, (token) => {
    if (token.type === "image") found.add("images");
    if (token.type === "html" && !/^<br\s*\/?>$/i.test(token.raw.trim())) found.add("raw HTML");
    if (
      (token.type === "text" || token.type === "link" || token.type === "def") &&
      /(?<!\\)\[\^[^\]\n]+\]/.test(token.raw)
    )
      found.add("footnotes");
  });
  // Marked resolves footnote-looking definitions as ordinary link definitions and omits their tokens.
  if (Object.keys(tokens.links).some((label) => label.startsWith("^"))) found.add("footnotes");
  return [...found];
}
