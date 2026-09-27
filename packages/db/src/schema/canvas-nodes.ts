import { index, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { canvases } from "./canvases";
import { entities } from "./entities";

export const canvasNodes = pgTable(
  "canvas_nodes",
  {
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    parentEntityId: uuid("parent_entity_id").references(() => entities.id, { onDelete: "set null" }),
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    width: integer("width").notNull().default(220),
    height: integer("height").notNull().default(120),
  },
  (table) => [
    primaryKey({ name: "canvas_nodes_pkey", columns: [table.canvasId, table.entityId] }),
    index("canvas_nodes_canvas_id_idx").on(table.canvasId),
    index("canvas_nodes_parent_entity_id_idx").on(table.parentEntityId),
  ],
);
