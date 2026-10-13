import { CircleAlert } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { type EditorLoader, loadEditor } from "./documentation/editor-loader";
import { MarkdownContent } from "./documentation/markdown-content";
import type { RichDocumentationProps } from "./rich-documentation-editor";

export { MarkdownContent } from "./documentation/markdown-content";

let sharedEditor = lazy(loadEditor);

/** Catches a failed editor chunk (offline, or a deploy removed it) so the inspector and the page keep working. */
class EditorLoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Mount the save lifecycle together with the editor, after its chunk has loaded. `load` exists for tests; it must stay
 * stable between renders.
 */
export function RichDocumentation({ load = loadEditor, ...props }: RichDocumentationProps & { load?: EditorLoader }) {
  const [attempt, setAttempt] = useState(0);
  const Editor = useMemo(() => {
    if (load !== loadEditor) return lazy(load);
    // React.lazy caches a rejected import, so a retry replaces the shared component. Once loaded, later mounts render
    // the editor without suspending again.
    if (attempt > 0) sharedEditor = lazy(loadEditor);
    return sharedEditor;
  }, [load, attempt]);
  return (
    <EditorLoadBoundary
      key={attempt}
      fallback={
        <section className="documentation-card" aria-label="Documentation">
          <p className="documentation-notice is-error" role="alert">
            <CircleAlert size={15} aria-hidden="true" />
            <span>The documentation editor could not load.</span>
            <button type="button" onClick={() => setAttempt((current) => current + 1)}>
              Retry
            </button>
          </p>
          <MarkdownContent value={props.value} />
        </section>
      }
    >
      <Suspense fallback={<p role="status">Loading documentation editor…</p>}>
        <Editor {...props} />
      </Suspense>
    </EditorLoadBoundary>
  );
}
