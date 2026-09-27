import { describe, expect, it } from "bun:test";
import { parseDatabaseSql } from "../src/features/inspector/database-schema-parser";

describe("database schema diagram source", () => {
  it("extracts tables, columns, and both inline and table foreign keys", () => {
    const schema = parseDatabaseSql(`
      CREATE TABLE users (id UUID PRIMARY KEY, name VARCHAR(100));
      CREATE TABLE playlists (
        id UUID,
        user_id UUID REFERENCES users(id),
        PRIMARY KEY (id)
      );
      CREATE TABLE playlist_songs (
        playlist_id UUID,
        song_id UUID,
        CONSTRAINT fk_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id)
      );
    `);
    expect(schema.tables.map((table) => table.name)).toEqual(["users", "playlists", "playlist_songs"]);
    expect(schema.tables[1].columns.find((column) => column.name === "id")?.primary).toBe(true);
    expect(schema.relations).toEqual([
      { from: "playlists", to: "users", column: "user_id" },
      { from: "playlist_songs", to: "playlists", column: "playlist_id" },
    ]);
  });
});
