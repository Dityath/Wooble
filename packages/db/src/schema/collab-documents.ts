import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const collabDocumentKinds = ["entity", "connection"] as const;
export type CollabDocumentKind = (typeof collabDocumentKinds)[number];
export const collabDocumentFields = ["documentation"] as const;
export type CollabDocumentField = (typeof collabDocumentFields)[number];
export const COLLAB_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const COLLAB_MIRROR_MAX_CHARS = 20000;

export const collabDocuments = pgTable(
  "collab_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    objectKind: text("object_kind").$type<CollabDocumentKind>().notNull(),
    objectId: uuid("object_id").notNull(),
    field: text("field").$type<CollabDocumentField>().notNull(),
    state: bytea("state"),
    mirrorMarkdown: text("mirror_markdown"),
    mirrorSha256: text("mirror_sha256"),
    originalMarkdown: text("original_markdown"),
    originalSha256: text("original_sha256"),
    schemaVersion: integer("schema_version"),
    bootstrapVersion: integer("bootstrap_version"),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantineReason: text("quarantine_reason"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("collab_documents_identity_key").on(table.objectKind, table.objectId, table.field),
    check("collab_documents_object_kind_check", sql`${table.objectKind} IN ('entity', 'connection')`),
    check("collab_documents_field_check", sql`${table.field} IN ('documentation')`),
    check(
      "collab_documents_state_size_check",
      sql`${table.state} IS NULL OR octet_length(${table.state}) <= ${sql.raw(String(COLLAB_STATE_MAX_BYTES))}`,
    ),
    check(
      "collab_documents_mirror_size_check",
      sql`${table.mirrorMarkdown} IS NULL OR char_length(${table.mirrorMarkdown}) <= ${sql.raw(String(COLLAB_MIRROR_MAX_CHARS))}`,
    ),
    check(
      "collab_documents_mirror_sha256_check",
      sql`${table.mirrorSha256} IS NULL OR ${table.mirrorSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "collab_documents_original_sha256_check",
      sql`${table.originalSha256} IS NULL OR ${table.originalSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "collab_documents_mirror_pair_check",
      sql`(${table.mirrorMarkdown} IS NULL) = (${table.mirrorSha256} IS NULL)`,
    ),
    check(
      "collab_documents_original_pair_check",
      sql`(${table.originalMarkdown} IS NULL) = (${table.originalSha256} IS NULL)`,
    ),
    check(
      "collab_documents_bootstrapped_state_check",
      sql`${table.state} IS NULL OR (${table.bootstrapVersion} IS NOT NULL AND ${table.mirrorMarkdown} IS NOT NULL)`,
    ),
    check(
      "collab_documents_quarantine_pair_check",
      sql`(${table.quarantinedAt} IS NULL) = (${table.quarantineReason} IS NULL)`,
    ),
    check("collab_documents_revision_check", sql`${table.revision} >= 0`),
    index("collab_documents_workspace_id_idx").on(table.workspaceId),
  ],
);
