import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ArchitectureConnection, ConnectionType } from "@wooble/domain";
import { entities } from "./entities";
import { workspaces } from "./workspaces";

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    type: text("type").$type<ConnectionType>().notNull(),
    label: text("label").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<ArchitectureConnection["metadata"]>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("connections_workspace_id_idx").on(table.workspaceId),
    index("connections_source_entity_id_idx").on(table.sourceEntityId),
    index("connections_target_entity_id_idx").on(table.targetEntityId),
  ],
);
