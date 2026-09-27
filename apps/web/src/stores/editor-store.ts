import { create } from "zustand";

interface Position {
  x: number;
  y: number;
}
interface EditorState {
  selectedEntityId: string | null;
  selectedConnectionId: string | null;
  positions: Record<string, Record<string, Position>>;
  setEntitySelected: (id: string | null) => void;
  setConnectionSelected: (id: string | null) => void;
  setPosition: (canvasId: string, id: string, position: Position) => void;
  clearPosition: (canvasId: string, id: string) => void;
  clearPositions: (canvasId: string) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedEntityId: null,
  selectedConnectionId: null,
  positions: {},
  setEntitySelected: (id) => set({ selectedEntityId: id, selectedConnectionId: null }),
  setConnectionSelected: (id) => set({ selectedEntityId: null, selectedConnectionId: id }),
  setPosition: (canvasId, id, position) =>
    set((state) => ({
      positions: { ...state.positions, [canvasId]: { ...state.positions[canvasId], [id]: position } },
    })),
  clearPosition: (canvasId, id) =>
    set((state) => {
      const canvasPositions = state.positions[canvasId];
      if (!canvasPositions || !(id in canvasPositions)) return state;

      const nextCanvasPositions = { ...canvasPositions };
      delete nextCanvasPositions[id];
      const positions = { ...state.positions };
      if (Object.keys(nextCanvasPositions).length === 0) delete positions[canvasId];
      else positions[canvasId] = nextCanvasPositions;
      return { positions };
    }),
  clearPositions: (canvasId) =>
    set((state) => {
      if (!state.positions[canvasId]) return state;
      const positions = { ...state.positions };
      delete positions[canvasId];
      return { positions };
    }),
}));
