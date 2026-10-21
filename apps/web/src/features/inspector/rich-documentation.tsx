import { DocumentationExportActions } from "./documentation/export-actions";
import { CircleAlert } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useMemo } from "react";
import { type EditorLoader, loadEditor } from "./documentation/editor-loader";
import { MarkdownContent } from "./documentation/markdown-content";
import type { RichDocumentationProps } from "./rich-documentation-editor";

export { MarkdownContent } from "./documentation/markdown-content";

const sharedEditor = lazy(loadEditor);

const reloadPage = () => window.location.reload();

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
 * Mount the save lifecycle together with the editor, after its chunk has loaded. `load` and `reload` exist for tests;
 * `load` must stay stable between renders.
 *
 * A failed chunk is not retried in place: browsers remember a failed dynamic import of the same address, so only a page
 * reload can recover. Unsaved documentation survives it (the draft, and the warning before leaving).
 */
export function RichDocumentation({
  load = loadEditor,
  reload = reloadPage,
  ...props
}: RichDocumentationProps & { load?: EditorLoader; reload?: () => void }) {
  const Editor = useMemo(() => (load === loadEditor ? sharedEditor : lazy(load)), [load]);
  return (
    <EditorLoadBoundary
      fallback={
        <section className="documentation-card" aria-label="Documentation">
          <p className="documentation-notice is-error" role="alert">
            <CircleAlert size={15} aria-hidden="true" />
            <span>
              The documentation editor could not load. Reload the page to try again. The documentation is shown below.
            </span>
            <button type="button" onClick={reload}>
              Reload
            </button>
          </p>
          <DocumentationExportActions markdown={props.value} name={props.name} />
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
