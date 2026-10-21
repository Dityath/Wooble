import { Copy, Download } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../../components/ui";
import { copyMarkdown, documentationFileName, downloadMarkdown } from "./export";

export function DocumentationExportActions({ markdown, name }: { markdown: string; name: string }) {
  const [status, setStatus] = useState({ message: "", operation: 0 });
  const emptyDescriptionId = useId();
  const announce = (message: string) => setStatus((previous) => ({ message, operation: previous.operation + 1 }));
  const disabled = markdown.length === 0;
  return (
    <div className="documentation-export-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-describedby={disabled ? emptyDescriptionId : undefined}
        onClick={() => {
          try {
            downloadMarkdown(markdown, documentationFileName(name));
            announce("Markdown downloaded");
          } catch {
            announce("Could not download Markdown. Try again.");
          }
        }}
      >
        <Download size={14} aria-hidden="true" /> Download Markdown
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-describedby={disabled ? emptyDescriptionId : undefined}
        onClick={async () => {
          try {
            await copyMarkdown(markdown);
            announce("Markdown copied");
          } catch {
            announce("Could not copy Markdown. Check clipboard permissions or download the file instead.");
          }
        }}
      >
        <Copy size={14} aria-hidden="true" /> Copy Markdown
      </Button>
      {disabled && <span id={emptyDescriptionId}>No saved documentation to export.</span>}
      <span role="status" aria-live="polite" aria-atomic="true">
        <span key={status.operation} data-operation={status.operation}>
          {status.message}
        </span>
      </span>
    </div>
  );
}
