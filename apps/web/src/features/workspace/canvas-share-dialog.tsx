import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Lock } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "../../components/ui";
import { api } from "../../lib/api";

type ShareMode = "restricted" | "link";

export function CanvasShareDialog({
  canvasId,
  open,
  onOpenChange,
}: {
  canvasId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canvas = useQuery({ queryKey: ["canvas", canvasId], queryFn: () => api.canvas(canvasId), enabled: open });
  const [mode, setMode] = useState<ShareMode>("restricted");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open && canvas.data) setMode(canvas.data.shareMode);
  }, [open, canvas.data]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const link = `${window.location.origin}/canvases/${canvasId}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Share canvas</DialogTitle>
        <DialogDescription>Choose who can open this canvas.</DialogDescription>
        {canvas.isPending ? (
          <p className="share-status">Loading access settings…</p>
        ) : canvas.isError ? (
          <p className="form-error" role="alert">
            {canvas.error.message}
          </p>
        ) : (
          <>
            <div className="share-mode-options" role="radiogroup" aria-label="Canvas link access">
              <label className="share-mode-option">
                <input
                  type="radio"
                  name="canvas-share-mode"
                  value="restricted"
                  className="share-mode-radio"
                  checked={mode === "restricted"}
                  onChange={() => setMode("restricted")}
                />
                <span>
                  <span className="share-mode-title">
                    <Lock size={14} /> Restricted
                  </span>
                  <small>Only canvas members can open.</small>
                </span>
              </label>
              <label className="share-mode-option">
                <input
                  type="radio"
                  name="canvas-share-mode"
                  value="link"
                  className="share-mode-radio"
                  checked={mode === "link"}
                  onChange={() => setMode("link")}
                />
                <span>
                  <span className="share-mode-title">
                    <Link2 size={14} /> Anyone with link
                  </span>
                  <small>Anyone with the link can view. Signed-in visitors remain viewers until removed.</small>
                </span>
              </label>
            </div>
            {canvas.data.shareMode === "link" && (
              <div className="share-link-row">
                <Input
                  aria-label="Canvas share link"
                  value={link}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            )}
            {mode === "link" && canvas.data.shareMode !== "link" && (
              <p className="share-link-hint">Save access to enable the link.</p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                type="button"
                disabled={saving || mode === canvas.data.shareMode}
                onClick={async () => {
                  setSaving(true);
                  setError("");
                  setCopied(false);
                  try {
                    await api.setCanvasShareMode(canvasId, mode);
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] }),
                      queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] }),
                    ]);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not update access");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Saving…" : "Save access"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
