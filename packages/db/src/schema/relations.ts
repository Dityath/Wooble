import { relations } from "drizzle-orm";
import { canvases } from "./canvases";
import { canvasConnections } from "./canvas-connections";
import { canvasNodes } from "./canvas-nodes";
import { connections } from "./connections";
import { entities } from "./entities";
import { workspaces } from "./workspaces";

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  canvases: many(canvases),
  entities: many(entities),
}));
export const canvasesRelations = relations(canvases, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [canvases.workspaceId], references: [workspaces.id] }),
  nodes: many(canvasNodes),
  connections: many(canvasConnections),
}));
export const entitiesRelations = relations(entities, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [entities.workspaceId], references: [workspaces.id] }),
  placements: many(canvasNodes),
  outgoing: many(connections, { relationName: "source" }),
  incoming: many(connections, { relationName: "target" }),
}));
export const connectionsRelations = relations(connections, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [connections.workspaceId], references: [workspaces.id] }),
  source: one(entities, { fields: [connections.sourceEntityId], references: [entities.id], relationName: "source" }),
  target: one(entities, { fields: [connections.targetEntityId], references: [entities.id], relationName: "target" }),
  placements: many(canvasConnections),
}));
export const canvasNodesRelations = relations(canvasNodes, ({ one }) => ({
  canvas: one(canvases, { fields: [canvasNodes.canvasId], references: [canvases.id] }),
  entity: one(entities, { fields: [canvasNodes.entityId], references: [entities.id], relationName: "placed_entity" }),
  parent: one(entities, {
    fields: [canvasNodes.parentEntityId],
    references: [entities.id],
    relationName: "parent_entity",
  }),
}));
export const canvasConnectionsRelations = relations(canvasConnections, ({ one }) => ({
  canvas: one(canvases, { fields: [canvasConnections.canvasId], references: [canvases.id] }),
  connection: one(connections, { fields: [canvasConnections.connectionId], references: [connections.id] }),
}));
