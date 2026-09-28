import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Undo2,
  GitBranch,
  History,
  Move,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import type { CanvasEvent } from "@wooble/contracts";
import { api } from "../../lib/api";
import { canvasShortcutLabel } from "./canvas-shortcuts";
import { seededParticipantColor } from "./participant-color";

const actionPresentation: Partial<Record<CanvasEvent["action"], { icon: typeof Plus; text: string }>> = {
  "entity.created": { icon: Plus, text: "created" },
  "entity.updated": { icon: Pencil, text: "updated" },
  "entity.deleted": { icon: Trash2, text: "deleted" },
  "connection.created": { icon: Workflow, text: "connected" },
  "connection.updated": { icon: GitBranch, text: "rerouted" },
  "connection.deleted": { icon: Trash2, text: "removed" },
  "placement.updated": { icon: Move, text: "moved" },
  "canvas.updated": { icon: Settings2, text: "updated" },
  "canvas.auto_neat": { icon: WandSparkles, text: "tidied the layout of" },
  "canvas.undo": { icon: Undo2, text: "undid" },
};

function relativeTime(timestamp: string, now: number) {
  const seconds = Math.max(1, Math.round((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function CanvasActivityLog({
  canvasId,
  open,
  onOpenChange,
}: {
  canvasId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof Element && target.closest("[role='dialog'], input, textarea, select")) return;
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);
  const activity = useQuery({
    queryKey: ["canvas-activity", canvasId],
    queryFn: () => api.canvasActivity(canvasId),
    enabled: open,
  });
  const events = activity.data ?? [];
  return (
    <>
      <section
        className={`canvas-activity-log${open ? " is-open" : ""}`}
        aria-label="Canvas activity"
        aria-hidden={!open}
      >
        <div className="canvas-activity-head">
          <span className="canvas-activity-title">Activity</span>
          <button
            type="button"
            className="canvas-activity-close"
            aria-label="Close activity log"
            onClick={() => onOpenChange(false)}
          >
            <X size={14} />
          </button>
        </div>
        <p className="canvas-activity-hint">{canvasShortcutLabel("undo")} undoes the last change</p>
        <div className="canvas-activity-list">
          {activity.isPending ? (
            <span className="canvas-activity-empty">Loading activity…</span>
          ) : activity.isError ? (
            <span className="canvas-activity-empty">Could not load activity</span>
          ) : !events.length ? (
            <span className="canvas-activity-empty">No activity yet</span>
          ) : (
            events.map((event) => <CanvasActivityItem event={event} now={now} key={event.id} />)
          )}
        </div>
      </section>
      <button
        type="button"
        className={`canvas-activity-toggle${open ? " is-open" : ""}`}
        aria-label="Toggle activity log"
        aria-expanded={open}
        title="Activity log"
        onClick={() => onOpenChange(!open)}
      >
        <History size={18} />
      </button>
    </>
  );
}

function CanvasActivityItem({ event, now }: { event: CanvasEvent; now: number }) {
  const presentation = actionPresentation[event.action] ?? { icon: History, text: "changed" };
  const Icon = presentation.icon;
  const undone = event.undoneAt !== null;
  return (
    <div className={`canvas-activity-item${undone ? " is-undone" : ""}`}>
      <span
        className="live-participant-avatar"
        style={{ "--peer-color": seededParticipantColor(event.actorUserId ?? event.actorName) } as React.CSSProperties}
      >
        {event.actorName.slice(0, 1).toUpperCase()}
      </span>
      <span className="live-participant-copy">
        <strong>
          {event.actorName} <span className="canvas-activity-action">{presentation.text}</span>{" "}
          {event.targetName && <span className="canvas-activity-target">{event.targetName}</span>}
        </strong>
        <small>
          {undone ? "undone · " : ""}
          {relativeTime(event.createdAt, now)}
        </small>
      </span>
      <Icon size={13} className="canvas-activity-icon" aria-hidden />
    </div>
  );
}
