import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema/index";

interface SnapshotTable {
  name: string;
  foreignKeys: Record<string, { tableTo: string; columnsFrom: string[]; columnsTo: string[]; onDelete: string }>;
  indexes: Record<string, { columns: Array<{ expression: string }>; isUnique: boolean }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

const migrationsDir = join(import.meta.dir, "../drizzle");
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const latest = journal.entries.at(-1);
if (!latest) throw new Error("The migration journal has no entries");
const snapshot = JSON.parse(
  readFileSync(join(migrationsDir, `meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`), "utf8"),
) as { tables: Record<string, SnapshotTable> };

const tables = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));
const tableConfig = (name: string) => {
  const config = tables.find((table) => table.name === name);
  if (!config) throw new Error(`No Drizzle table named ${name}`);
  return config;
};

function foreignKeys(name: string) {
  return tableConfig(name)
    .foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        name: foreignKey.getName(),
        tableTo: getTableConfig(reference.foreignTable).name,
        columnsFrom: reference.columns.map((column) => column.name),
        columnsTo: reference.foreignColumns.map((column) => column.name),
        onDelete: (foreignKey.onDelete ?? "no action") as string,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function indexes(name: string) {
  return tableConfig(name)
    .indexes.map((index) => ({
      name: index.config.name ?? "",
      columns: index.config.columns.map((column) => ("name" in column ? column.name : String(column))),
      unique: index.config.unique,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("database schema", () => {
  it("defines the same tables as the latest checked-in migration", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(
      Object.values(snapshot.tables)
        .map((table) => table.name)
        .sort(),
    );
  });

  it("keeps foreign keys and delete rules aligned with the migrations", () => {
    for (const table of Object.values(snapshot.tables)) {
      const expected = Object.entries(table.foreignKeys)
        .map(([name, foreignKey]) => ({
          name,
          tableTo: foreignKey.tableTo,
          columnsFrom: foreignKey.columnsFrom,
          columnsTo: foreignKey.columnsTo,
          onDelete: foreignKey.onDelete,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect({ table: table.name, foreignKeys: foreignKeys(table.name) }).toEqual({
        table: table.name,
        foreignKeys: expected,
      });
    }
  });

  it("keeps indexes, composite primary keys, and unique constraints aligned with the migrations", () => {
    for (const table of Object.values(snapshot.tables)) {
      const config = tableConfig(table.name);
      const expectedIndexes = Object.entries(table.indexes)
        .map(([name, index]) => ({
          name,
          columns: index.columns.map((column) => column.expression),
          unique: index.isUnique,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect({ table: table.name, indexes: indexes(table.name) }).toEqual({
        table: table.name,
        indexes: expectedIndexes,
      });
      expect(
        config.primaryKeys.map((key) => ({ name: key.getName(), columns: key.columns.map((c) => c.name) })),
      ).toEqual(Object.entries(table.compositePrimaryKeys).map(([name, key]) => ({ name, columns: key.columns })));
      const uniqueColumns = [
        ...config.uniqueConstraints.map((constraint) => constraint.columns.map((column) => column.name)),
        ...config.columns.filter((column) => column.isUnique).map((column) => [column.name]),
      ];
      expect(uniqueColumns).toEqual(Object.values(table.uniqueConstraints).map((constraint) => constraint.columns));
    }
  });

  it("removes workspace content and access when a workspace is deleted", () => {
    for (const table of ["canvases", "entities", "connections", "workspace_members", "invitations"])
      expect(foreignKeys(table).find((key) => key.tableTo === "workspaces")?.onDelete).toBe("cascade");
  });

  it("keeps the canvas activity log when its actor account is deleted", () => {
    expect(foreignKeys("canvas_events").find((key) => key.tableTo === "users")).toMatchObject({
      columnsFrom: ["actor_user_id"],
      onDelete: "set null",
    });
  });

  it("keeps a child placement on the canvas when its parent system is deleted", () => {
    expect(foreignKeys("canvas_nodes").find((key) => key.columnsFrom[0] === "parent_entity_id")).toMatchObject({
      tableTo: "entities",
      onDelete: "set null",
    });
  });

  it("allows one account per email address", () => {
    expect(indexes("users")).toContainEqual({ name: "users_email_unique", columns: ["email"], unique: true });
  });
});
