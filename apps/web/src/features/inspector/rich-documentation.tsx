import { lazy, Suspense } from "react";

const LazyDocumentation = lazy(() =>
  import("./rich-documentation-editor").then((module) => ({ default: module.RichDocumentation })),
);

export { MarkdownContent } from "./documentation/markdown-content";

/** Mount the save lifecycle together with the editor, after its chunk has loaded. */
export function RichDocumentation(props: { value: string; onSave: (value: string) => Promise<void> }) {
  return (
    <Suspense fallback={<p role="status">Loading documentation editor…</p>}>
      <LazyDocumentation {...props} />
    </Suspense>
  );
}
