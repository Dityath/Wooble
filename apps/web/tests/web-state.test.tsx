import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { participantColor, participantColors, seededParticipantColor } from "../src/features/canvas/participant-color";
import { connectionTitle } from "../src/lib/connection-title";
import { useAppearance } from "../src/lib/use-appearance";
import { useEditorStore } from "../src/stores/editor-store";

describe("useAppearance", () => {
  it("follows the system preference until the viewer picks a theme", () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" }) as MediaQueryList,
    );
    try {
      const { result } = renderHook(() => useAppearance());
      expect(result.current.theme).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      media.mockRestore();
    }
  });

  it("remembers the chosen theme and updates every mounted consumer", () => {
    const first = renderHook(() => useAppearance());
    const second = renderHook(() => useAppearance());
    expect(first.result.current.theme).toBe("light");

    act(() => first.result.current.setTheme("dark"));
    expect(localStorage.getItem("wooble-theme")).toBe("dark");
    expect(second.result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("picks up a theme changed in another tab", () => {
    const { result } = renderHook(() => useAppearance());
    localStorage.setItem("wooble-theme", "dark");
    act(() => {
      window.dispatchEvent(new Event("storage"));
    });
    expect(result.current.theme).toBe("dark");
  });
});

describe("editor store", () => {
  beforeEach(() => {
    useEditorStore.setState({ selectedEntityId: null, selectedConnectionId: null, positions: {} });
  });

  it("selects either a node or a connection, never both", () => {
    const store = useEditorStore.getState();
    store.setEntitySelected("node-1");
    expect(useEditorStore.getState()).toMatchObject({ selectedEntityId: "node-1", selectedConnectionId: null });
    store.setConnectionSelected("edge-1");
    expect(useEditorStore.getState()).toMatchObject({ selectedEntityId: null, selectedConnectionId: "edge-1" });
  });

  it("keeps unsaved positions per canvas and cleans up empty canvases", () => {
    const store = useEditorStore.getState();
    store.setPosition("canvas-a", "node-1", { x: 1, y: 2 });
    store.setPosition("canvas-a", "node-2", { x: 3, y: 4 });
    store.setPosition("canvas-b", "node-1", { x: 5, y: 6 });

    store.clearPosition("canvas-a", "node-1");
    expect(useEditorStore.getState().positions).toEqual({
      "canvas-a": { "node-2": { x: 3, y: 4 } },
      "canvas-b": { "node-1": { x: 5, y: 6 } },
    });
    store.clearPosition("canvas-a", "node-2");
    expect(Object.keys(useEditorStore.getState().positions)).toEqual(["canvas-b"]);

    const before = useEditorStore.getState();
    store.clearPosition("canvas-a", "missing");
    store.clearPositions("canvas-missing");
    expect(useEditorStore.getState()).toBe(before);

    store.clearPositions("canvas-b");
    expect(useEditorStore.getState().positions).toEqual({});
  });
});

describe("display helpers", () => {
  it("cycles participant colors by index and keeps seeded colors stable", () => {
    expect(participantColor(0)).toBe(participantColors[0]);
    expect(participantColor(participantColors.length + 1)).toBe(participantColors[1]);
    expect(seededParticipantColor("user-42")).toBe(seededParticipantColor("user-42"));
    expect(participantColors).toContain(seededParticipantColor("another-user"));
  });

  it("titles a connection by its label or falls back to the protocol name", () => {
    expect(connectionTitle({ label: "  Reads orders ", type: "database" })).toBe("Reads orders");
    expect(connectionTitle({ label: "   ", type: "grpc" })).toBe("gRPC");
    expect(connectionTitle({ label: "", type: "rest" })).toBe("REST");
  });
});
