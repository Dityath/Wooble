export interface ArchitectureCanvas {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  shareMode: "restricted" | "link";
  updatedAt: string;
}

/** Placement is presentation data; entity metadata remains in ArchitectureEntity. */
export interface CanvasNode {
  canvasId: string;
  entityId: string;
  parentEntityId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasConnection {
  canvasId: string;
  connectionId: string;
}

export function canvasSubtreeIds(
  placements: Array<Pick<CanvasNode, "entityId" | "parentEntityId">>,
  rootId: string,
): string[] {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const placement of placements) {
      if (placement.parentEntityId && ids.has(placement.parentEntityId) && !ids.has(placement.entityId)) {
        ids.add(placement.entityId);
        changed = true;
      }
    }
  }
  return [...ids];
}
