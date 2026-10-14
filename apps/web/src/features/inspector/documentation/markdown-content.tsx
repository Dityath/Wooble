import { decodeNamedCharacterReference } from "decode-named-character-reference";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** URL schemes documentation may link to or embed. Every other scheme is rendered as text, never as a live URL. */
const allowedSchemes = new Set(["http", "https", "mailto"]);

/** A character reference a browser decodes before it reads a URL, such as `&#58;`, `&#9;` or `&Tab;`. */
const characterReference = /&(?:#[0-9]{1,7}|#[xX][0-9a-f]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g;

/** Returns what `reference` stands for, or `reference` itself when it is not one. */
function decodeReference(reference: string): string {
  const name = reference.slice(1, reference.endsWith(";") ? -1 : undefined);
  if (name.startsWith("#")) {
    const hexadecimal = name[1] === "x" || name[1] === "X";
    const code = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return reference;
    return String.fromCodePoint(code);
  }
  return decodeNamedCharacterReference(name) || reference;
}

/**
 * Returns `url` when documentation may link to or embed it, and `""` when it may not. Only `http`, `https` and
 * `mailto` are allowed, so `javascript:`, `data:`, `vbscript:` and `file:` never reach an `href` or a `src`. A relative
 * URL (`./runbook.md`) and an anchor (`#rollback`) are allowed, as is a `:` that follows a `/`, `?` or `#`, which
 * belongs to the path or query rather than to a scheme.
 *
 * The scheme is read the way a browser reads it, on `url` decoded and with whitespace and control characters removed, so
 * `java&#9;script:alert(1)` and `java\tscript:alert(1)` are refused as well. The URL that is allowed is returned as it
 * was written, so nothing else about it changes.
 *
 * The read-only renderer and the editor share this, so a URL that one of them refuses is refused by both. It lives here
 * because this module has no editor dependency: the editor reuses the rule without loading the reader.
 */
// biome-ignore lint/style/useComponentExportOnlyModules: the rule the renderer enforces belongs beside it; a separate module could only be added by lifting it out of this directory.
export function safeDocumentationUrl(url: string): string {
  const readable = url.replace(characterReference, decodeReference).replace(/[\s\p{Cc}]/gu, "");
  const colon = readable.indexOf(":");
  if (colon === -1) return url;
  const slash = readable.indexOf("/");
  const questionMark = readable.indexOf("?");
  const numberSign = readable.indexOf("#");
  const afterPath =
    (slash !== -1 && slash < colon) ||
    (questionMark !== -1 && questionMark < colon) ||
    (numberSign !== -1 && numberSign < colon);
  if (afterPath) return url;
  return allowedSchemes.has(readable.slice(0, colon).toLowerCase()) ? url : "";
}

/**
 * Read-only documentation. It has no editor dependencies, so pages that only read documentation, such as the entity
 * page, do not load the editor.
 */
export function MarkdownContent({ value }: { value: string }) {
  return value ? (
    <article className="rich-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeDocumentationUrl}>
        {value}
      </ReactMarkdown>
    </article>
  ) : (
    <p className="rich-empty">No documentation yet.</p>
  );
}
