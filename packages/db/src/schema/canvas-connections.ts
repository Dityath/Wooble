import { index, jsonb, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import type { ConnectionPath } from "@wooble/domain";
import { canvases } from "./canvases";
import { connections } from "./connections";

export const canvasConnections = pgTable(
  "canvas_connections",
  {
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    bend: jsonb("bend").$type<ConnectionPath>(),
  },
  (table) => [
    primaryKey({ name: "canvas_connections_pkey", columns: [table.canvasId, table.connectionId] }),
    index("canvas_connections_canvas_id_idx").on(table.canvasId),
  ],
);
