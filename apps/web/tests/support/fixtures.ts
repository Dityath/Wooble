import type { CanvasEvent, CanvasGraph, CanvasSummary, Member, User, WorkspaceSummary } from "../../src/lib/api";
import type { ArchitectureEntity, ConnectionPath, EntityMetadata, EntityType } from "@wooble/domain";

/** Fictional, stable identifiers shared across web tests. */
export const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  otherUser: "00000000-0000-4000-8000-000000000002",
  workspace: "10000000-0000-4000-8000-000000000001",
  otherWorkspace: "10000000-0000-4000-8000-000000000002",
  canvas: "20000000-0000-4000-8000-000000000001",
  otherCanvas: "20000000-0000-4000-8000-000000000002",
  system: "30000000-0000-4000-8000-000000000001",
  service: "30000000-0000-4000-8000-000000000002",
  database: "30000000-0000-4000-8000-000000000003",
  gateway: "30000000-0000-4000-8000-000000000004",
  connection: "40000000-0000-4000-8000-000000000001",
  secondConnection: "40000000-0000-4000-8000-000000000002",
  event: "50000000-0000-4000-8000-000000000001",
};

const timestamp = "2026-09-01T10:00:00.000Z";

export function user(overrides: Partial<User> = {}): User {
  return { id: ids.user, name: "Ada Lovelace", email: "ada@example.test", systemRole: "user", ...overrides };
}

export function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: ids.workspace,
    name: "Payments",
    description: "Checkout and billing",
    updatedAt: timestamp,
    role: "manager",
    canvasCount: 1,
    ...overrides,
  };
}

export function canvasSummary(overrides: Partial<CanvasSummary> = {}): CanvasSummary {
  return {
    id: ids.canvas,
    workspaceId: ids.workspace,
    name: "Checkout flow",
    description: "Order placement",
    shareMode: "restricted",
    updatedAt: timestamp,
    systemCount: 1,
    serviceCount: 2,
    ...overrides,
  };
}

export function member(overrides: Partial<Member> = {}): Member {
  return { id: ids.otherUser, name: "Grace Hopper", email: "grace@example.test", role: "member", ...overrides };
}

export function entity(
  id: string,
  type: EntityType,
  name: string,
  metadata: EntityMetadata = {},
  description: string | null = null,
): ArchitectureEntity {
  return {
    id,
    workspaceId: ids.workspace,
    type,
    name,
    description,
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function graph(overrides: Partial<CanvasGraph> = {}): CanvasGraph {
  const bend: ConnectionPath = null;
  return {
    canvas: {
      id: ids.canvas,
      workspaceId: ids.workspace,
      name: "Checkout flow",
      description: "Order placement",
      shareMode: "restricted",
      updatedAt: timestamp,
    },
    entities: [
      entity(ids.system, "system", "Storefront"),
      entity(ids.service, "service", "Orders API", { language: "TypeScript", status: "implemented" }),
      entity(ids.database, "database", "Orders DB", { engine: "PostgreSQL" }),
    ],
    placements: [
      { canvasId: ids.canvas, entityId: ids.system, parentEntityId: null, x: 0, y: 0, width: 640, height: 400 },
      {
        canvasId: ids.canvas,
        entityId: ids.service,
        parentEntityId: ids.system,
        x: 40,
        y: 80,
        width: 220,
        height: 120,
      },
      { canvasId: ids.canvas, entityId: ids.database, parentEntityId: null, x: 800, y: 80, width: 220, height: 120 },
    ],
    connections: [
      {
        id: ids.connection,
        workspaceId: ids.workspace,
        sourceEntityId: ids.service,
        targetEntityId: ids.database,
        type: "database",
        label: "Reads orders",
        description: null,
        metadata: {},
        bend,
      },
    ],
    ...overrides,
  };
}

export function canvasEvent(overrides: Partial<CanvasEvent> = {}): CanvasEvent {
  return {
    id: ids.event,
    actorUserId: ids.user,
    actorName: "Ada Lovelace",
    action: "entity.updated",
    targetType: "entity",
    targetId: ids.service,
    targetName: "Orders API",
    metadata: {},
    undoneAt: null,
    createdAt: timestamp,
    ...overrides,
  };
}
