import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EntityMetadata, EntityType } from "@wooble/domain";
import { workspaces } from "./workspaces";

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").$type<EntityType>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<EntityMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("entities_workspace_id_idx").on(table.workspaceId), index("entities_type_idx").on(table.type)],
);
