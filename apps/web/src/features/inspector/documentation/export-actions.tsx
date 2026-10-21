import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui";
import { copyMarkdown, documentationFileName, downloadMarkdown } from "./export";

export function DocumentationExportActions({ markdown, name }: { markdown: string; name: string }) {
  const [status, setStatus] = useState("");
  const disabled = markdown.length === 0;
  const title = disabled ? "No saved documentation to export." : undefined;
  return (
    <div className="documentation-export-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        title={title}
        onClick={() => {
          try {
            downloadMarkdown(markdown, documentationFileName(name));
            setStatus("Markdown downloaded");
          } catch {
            setStatus("Could not download Markdown. Try again.");
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
        title={title}
        onClick={async () => {
          try {
            await copyMarkdown(markdown);
            setStatus("Markdown copied");
          } catch {
            setStatus("Could not copy Markdown. Check clipboard permissions or download the file instead.");
          }
        }}
      >
        <Copy size={14} aria-hidden="true" /> Copy Markdown
      </Button>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
