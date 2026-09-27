import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { canvases } from "./canvases";
import { users } from "./access";

export const canvasEventActions = [
  "entity.created",
  "entity.updated",
  "entity.deleted",
  "connection.created",
  "connection.updated",
  "connection.deleted",
  "placement.updated",
  "canvas.updated",
  "canvas.auto_neat",
  "canvas.undo",
] as const;
export type CanvasEventAction = (typeof canvasEventActions)[number];

export const canvasEvents = pgTable(
  "canvas_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canvasId: uuid("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    action: text("action").$type<CanvasEventAction>().notNull(),
    targetType: text("target_type").$type<"entity" | "connection" | "canvas">().notNull(),
    targetId: uuid("target_id"),
    targetName: text("target_name"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("canvas_events_canvas_id_created_at_idx").on(table.canvasId, table.createdAt)],
);
