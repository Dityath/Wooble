import { createContext } from "react";
import type { SystemResizeBounds } from "./system-resize";

export interface SystemResizeControls {
  enabled: boolean;
  canResize: (id: string, bounds: SystemResizeBounds) => boolean;
  onStart: (id: string) => void;
  onEnd: (id: string, bounds: SystemResizeBounds) => void;
}

export const SystemResizeContext = createContext<SystemResizeControls>({
  enabled: false,
  canResize: () => false,
  onStart: () => {},
  onEnd: () => {},
});
