import type { CanvasNode } from "@wooble/domain";

export interface SystemResizeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SystemResizeSnapshot {
  system: CanvasNode;
  children: CanvasNode[];
}

export function canResizeSystem(snapshot: SystemResizeSnapshot, bounds: SystemResizeBounds): boolean {
  const { system, children } = snapshot;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const oldRight = system.x + system.width;
  const oldBottom = system.y + system.height;

  return children.every((child) => {
    const left = system.x + child.x;
    const top = system.y + child.y;
    // Only constrain an edge that moves inward. Expanding an older, tight system stays possible.
    return (
      (bounds.x <= system.x || left >= bounds.x + 16) &&
      (bounds.y <= system.y || top >= bounds.y + 56) &&
      (right >= oldRight || left + child.width <= right - 16) &&
      (bottom >= oldBottom || top + child.height <= bottom - 16)
    );
  });
}

export function resizedSystemPlacements(snapshot: SystemResizeSnapshot, bounds: SystemResizeBounds): CanvasNode[] {
  const system = {
    ...snapshot.system,
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  const dx = system.x - snapshot.system.x;
  const dy = system.y - snapshot.system.y;
  return dx || dy
    ? [system, ...snapshot.children.map((child) => ({ ...child, x: child.x - dx, y: child.y - dy }))]
    : [system];
}
