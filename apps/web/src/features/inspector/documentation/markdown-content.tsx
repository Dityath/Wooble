import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Read-only documentation. It has no editor dependencies, so pages that only read documentation, such as the entity
 * page, do not load the editor.
 */
export function MarkdownContent({ value }: { value: string }) {
  return value ? (
    <article className="rich-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </article>
  ) : (
    <p className="rich-empty">No documentation yet.</p>
  );
}
