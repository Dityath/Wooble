import { describe, expect, test } from "bun:test";
import {
  canvasShortcutLabel,
  resolveCanvasKeyDown,
  type CanvasKeyContext,
  type CanvasKeyEvent,
  type CanvasShortcutAction,
} from "../src/features/canvas/canvas-shortcuts";

describe("canvas shortcut labels", () => {
  const actions: CanvasShortcutAction[] = ["select", "hand", "node", "connector", "system", "edit-connector", "undo"];

  test("show the Cmd modifier on Apple platforms", () => {
    expect(actions.map((action) => canvasShortcutLabel(action, true))).toEqual([
      "⌘S",
      "⌘H",
      "⌘N",
      "⌘C",
      "⌘B",
      "⌘E",
      "⌘Z",
    ]);
  });

  test("show the Ctrl modifier elsewhere", () => {
    expect(actions.map((action) => canvasShortcutLabel(action, false))).toEqual([
      "Ctrl+S",
      "Ctrl+H",
      "Ctrl+N",
      "Ctrl+C",
      "Ctrl+B",
      "Ctrl+E",
      "Ctrl+Z",
    ]);
  });
});

interface KeyEventOverrides extends Partial<Omit<CanvasKeyEvent, "key">> {
  key?: string;
}

const baseContext: CanvasKeyContext = {
  busy: false,
  detailsOpen: false,
  selection: null,
  inInteractiveTarget: false,
  onConnectorBendHandle: false,
};

const key = (overrides: KeyEventOverrides = {}): CanvasKeyEvent => ({
  key: "s",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...overrides,
});

const resolve = (event: CanvasKeyEvent, context: Partial<CanvasKeyContext> = {}) =>
  resolveCanvasKeyDown(event, { ...baseContext, ...context });

describe("canvas tool shortcuts", () => {
  test("map Cmd/Ctrl + letter to each tool", () => {
    const cases: Array<[CanvasKeyEvent, string]> = [
      [key({ ctrlKey: true }), "select"],
      [key({ key: "s", metaKey: true }), "select"],
      [key({ key: "h", metaKey: true }), "hand"],
      [key({ key: "n", ctrlKey: true }), "node"],
      [key({ key: "c", metaKey: true }), "connector"],
      [key({ key: "b", ctrlKey: true }), "system"],
      [key({ key: "e", metaKey: true }), "edit-connector"],
    ];
    for (const [event, tool] of cases) expect(resolve(event)).toEqual({ kind: "tool", tool });
  });

  test("refuse bare letters so advertised shortcuts match the handler", () => {
    for (const letter of ["s", "h", "n", "c", "b", "e"]) {
      expect(resolve(key({ key: letter }))).toEqual({ kind: "none" });
    }
  });

  test("ignore Alt and Shift variants and held-down repeats", () => {
    expect(resolve(key({ altKey: true, ctrlKey: true }))).toEqual({ kind: "none" });
    expect(resolve(key({ shiftKey: true, metaKey: true }))).toEqual({ kind: "none" });
    expect(resolve(key({ repeat: true, metaKey: true }))).toEqual({ kind: "none" });
    expect(resolve(key({ key: "x", metaKey: true }))).toEqual({ kind: "none" });
    expect(resolve(key({ key: "z", altKey: true, metaKey: true }))).toEqual({ kind: "none" });
  });

  test("swallow tool shortcuts while a create or Auto Neat is in flight", () => {
    expect(resolve(key({ metaKey: true }), { busy: true })).toEqual({ kind: "swallow" });
    expect(resolve(key({ key: "c", ctrlKey: true }), { busy: true })).toEqual({ kind: "swallow" });
  });
});

describe("canvas undo shortcut", () => {
  test("Cmd/Ctrl + Z undoes", () => {
    expect(resolve(key({ key: "z", metaKey: true }))).toEqual({ kind: "undo" });
    expect(resolve(key({ key: "z", ctrlKey: true }))).toEqual({ kind: "undo" });
  });

  test("refuse redo variants and wait while busy", () => {
    expect(resolve(key({ key: "z", shiftKey: true, metaKey: true }))).toEqual({ kind: "swallow" });
    expect(resolve(key({ key: "z", ctrlKey: true }), { busy: true })).toEqual({ kind: "swallow" });
  });
});

describe("Backspace and Delete on selected canvas items", () => {
  test("request a confirmed deletion for both keys and both selection kinds", () => {
    expect(resolve(key({ key: "Backspace" }), { selection: "entity" })).toEqual({ kind: "request-delete" });
    expect(resolve(key({ key: "Delete" }), { selection: "entity" })).toEqual({ kind: "request-delete" });
    expect(resolve(key({ key: "Backspace" }), { selection: "connection" })).toEqual({ kind: "request-delete" });
    expect(resolve(key({ key: "Delete" }), { selection: "connection" })).toEqual({ kind: "request-delete" });
  });

  test("do nothing without a selection or with modifiers", () => {
    expect(resolve(key({ key: "Backspace" }))).toEqual({ kind: "none" });
    expect(resolve(key({ key: "Delete" }))).toEqual({ kind: "none" });
    expect(resolve(key({ key: "Backspace", ctrlKey: true }), { selection: "entity" })).toEqual({ kind: "none" });
    expect(resolve(key({ key: "Backspace", altKey: true }), { selection: "entity" })).toEqual({ kind: "none" });
  });

  test("keep typing keys untouched in inputs and open dialogs", () => {
    for (const context of [{ inInteractiveTarget: true }, { detailsOpen: true }]) {
      expect(resolve(key({ key: "Backspace" }), { ...context, selection: "entity" })).toEqual({ kind: "none" });
      expect(resolve(key({ key: "Delete" }), { ...context, selection: "entity" })).toEqual({ kind: "none" });
      expect(resolve(key({ key: "z", metaKey: true }), context)).toEqual({ kind: "none" });
      expect(resolve(key({ key: "s", ctrlKey: true }), context)).toEqual({ kind: "none" });
    }
  });

  test("leave focused connector bend points to their own handler", () => {
    expect(resolve(key({ key: "Delete" }), { selection: "connection", onConnectorBendHandle: true })).toEqual({
      kind: "none",
    });
    expect(resolve(key({ key: "Backspace" }), { selection: "entity", onConnectorBendHandle: true })).toEqual({
      kind: "none",
    });
  });

  test("wait while a create or Auto Neat is in flight", () => {
    expect(resolve(key({ key: "Backspace" }), { selection: "entity", busy: true })).toEqual({ kind: "swallow" });
    expect(resolve(key({ key: "Delete" }), { selection: "connection", busy: true })).toEqual({ kind: "swallow" });
    expect(resolve(key({ key: "Backspace", repeat: true }), { selection: "entity" })).toEqual({ kind: "none" });
  });

  test("ignore unrelated keys", () => {
    expect(resolve(key({ key: "x" }), { selection: "entity" })).toEqual({ kind: "none" });
    expect(resolve(key({ key: "Escape" }), { selection: "entity" })).toEqual({ kind: "none" });
  });
});
