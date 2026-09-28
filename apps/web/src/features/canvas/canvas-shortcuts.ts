export type CanvasTool = "select" | "hand" | "node" | "connector" | "system" | "edit-connector";

export type CanvasShortcutAction = CanvasTool | "undo";

const SHORTCUT_KEYS: Record<CanvasShortcutAction, string> = {
  select: "S",
  hand: "H",
  node: "N",
  connector: "C",
  system: "B",
  "edit-connector": "E",
  undo: "Z",
};

const TOOL_KEYS: Record<string, CanvasTool> = {
  s: "select",
  h: "hand",
  n: "node",
  c: "connector",
  b: "system",
  e: "edit-connector",
};

export function isApplePlatform(
  platformHint = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`,
): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platformHint);
}

/**
 * Visible shortcut hint for a canvas action, e.g. "⌘S" on Apple platforms and
 * "Ctrl+S" elsewhere. Only actions with a real keyboard shortcut are listed in
 * CanvasShortcutAction, so controls without one (Auto Neat, Zen mode, zoom)
 * cannot advertise a shortcut by construction.
 */
export function canvasShortcutLabel(action: CanvasShortcutAction, apple = isApplePlatform()): string {
  return apple ? `⌘${SHORTCUT_KEYS[action]}` : `Ctrl+${SHORTCUT_KEYS[action]}`;
}

export interface CanvasKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export interface CanvasKeyContext {
  /** A create or Auto Neat request is in flight; tool switches, undo, and deletion wait. */
  busy: boolean;
  /** The canvas details dialog is open. */
  detailsOpen: boolean;
  /** Selected canvas item, if any. */
  selection: "entity" | "connection" | null;
  /** The key target is an open dialog or a text-editing surface; typing keys must pass through. */
  inInteractiveTarget: boolean;
  /** The key target is a focused connector bend point; Delete/Backspace remove only that point. */
  onConnectorBendHandle: boolean;
}

export type CanvasKeyAction =
  | { kind: "tool"; tool: CanvasTool }
  | { kind: "undo" }
  | { kind: "request-delete" }
  | { kind: "swallow" }
  | { kind: "none" };

/**
 * Resolves a keydown against the canvas editor's actual shortcut semantics:
 * tool shortcuts and undo require Cmd/Ctrl; Backspace/Delete open the confirmed
 * canvas-item deletion. "swallow" means the key is recognized but refused
 * (for example while a request is in flight) and should not reach the browser.
 */
export function resolveCanvasKeyDown(event: CanvasKeyEvent, context: CanvasKeyContext): CanvasKeyAction {
  const { key, metaKey, ctrlKey, altKey, shiftKey, repeat } = event;
  const { busy, detailsOpen, selection, inInteractiveTarget, onConnectorBendHandle } = context;
  if (repeat || inInteractiveTarget || detailsOpen) return { kind: "none" };
  const lowerKey = key.toLowerCase();
  if (metaKey || ctrlKey) {
    if (altKey) return { kind: "none" };
    if (lowerKey === "z") {
      if (shiftKey) return { kind: "swallow" };
      return busy ? { kind: "swallow" } : { kind: "undo" };
    }
    if (shiftKey) return { kind: "none" };
    const tool = TOOL_KEYS[lowerKey];
    if (!tool) return { kind: "none" };
    return busy ? { kind: "swallow" } : { kind: "tool", tool };
  }
  if (altKey) return { kind: "none" };
  if (key !== "Backspace" && key !== "Delete") return { kind: "none" };
  if (onConnectorBendHandle) return { kind: "none" };
  if (busy) return { kind: "swallow" };
  if (!selection) return { kind: "none" };
  return { kind: "request-delete" };
}
