import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrateDatabase, readJournal, scratchDatabase } from "./support/migrations";

// The last migration in the v0.1.0 release. Each later release keeps this test and adds its own previous release.
const v010 = "0005_tranquil_prima";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  home: "00000000-0000-4000-8000-000000000003",
  board: "00000000-0000-4000-8000-000000000004",
  api: "00000000-0000-4000-8000-000000000005",
  database: "00000000-0000-4000-8000-000000000006",
  connection: "00000000-0000-4000-8000-000000000007",
  event: "00000000-0000-4000-8000-000000000008",
};

const documentation =
  "## Orders API\n\n- Retries **twice**\n- [ ] Add rate limits\n\n| Field | Type |\n| --- | --- |\n| id | uuid |";
const schemaSql = "CREATE TABLE orders (\n  id uuid PRIMARY KEY,\n  total numeric NOT NULL\n);";
const contractBody = '{"openapi":"3.0.3","info":{"title":"Orders","version":"1"},"paths":{"/orders":{"get":{}}}}';

/** Content written through the v0.1.0 schema, with fictional values, including text later releases may convert. */
const seed = sql.raw(`
  INSERT INTO users (id, email, name, password_hash) VALUES
    ('${ids.user}', 'upgrade-owner@example.test', 'Upgrade Owner', 'scrypt$fictional');
  INSERT INTO workspaces (id, name, description) VALUES ('${ids.workspace}', 'Upgrade workspace', 'Seeded at v0.1.0');
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('${ids.workspace}', '${ids.user}', 'manager');
  INSERT INTO canvases (id, workspace_id, name, share_mode) VALUES
    ('${ids.home}', '${ids.workspace}', 'Home', 'restricted'),
    ('${ids.board}', '${ids.workspace}', 'Board', 'link');
  INSERT INTO entities (id, workspace_id, type, name, description, metadata) VALUES
    ('${ids.api}', '${ids.workspace}', 'service', 'Orders API', 'Takes orders',
      jsonb_build_object('documentation', $doc$${documentation}$doc$, 'technology', 'go')),
    ('${ids.database}', '${ids.workspace}', 'database', 'Orders DB', null,
      jsonb_build_object('schemaSql', $sql$${schemaSql}$sql$));
  INSERT INTO canvas_nodes (canvas_id, entity_id, x, y, width, height) VALUES
    ('${ids.home}', '${ids.api}', 10, 20, 220, 120),
    ('${ids.home}', '${ids.database}', 400, 20, 220, 120),
    ('${ids.board}', '${ids.api}', 60, 80, 260, 140);
  INSERT INTO connections (id, workspace_id, source_entity_id, target_entity_id, type, label, metadata) VALUES
    ('${ids.connection}', '${ids.workspace}', '${ids.api}', '${ids.database}', 'rest', 'Reads orders',
      jsonb_build_object('contract', 'GET /orders', 'contractBody', $body$${contractBody}$body$,
        'documentation', 'Uses a read replica.'));
  INSERT INTO canvas_connections (canvas_id, connection_id, bend) VALUES ('${ids.home}', '${ids.connection}', '{"x":200,"y":60}');
  INSERT INTO canvas_events (id, canvas_id, actor_user_id, actor_name, action, target_type, target_id, target_name, metadata)
    VALUES ('${ids.event}', '${ids.home}', '${ids.user}', 'Upgrade Owner', 'entity.updated', 'entity', '${ids.api}',
      'Orders API', jsonb_build_object('fields', jsonb_build_array('metadata')));
`);

/** The v0.1.0 columns of the seeded rows. New columns added by later migrations are deliberately ignored. */
const snapshot = sql.raw(`
  SELECT jsonb_build_object(
    'users', (SELECT jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name, 'role', system_role)) FROM users),
    'workspaces', (SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description)) FROM workspaces),
    'members', (SELECT jsonb_agg(jsonb_build_object('workspace', workspace_id, 'user', user_id, 'role', role)) FROM workspace_members),
    'canvases', (SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'share', share_mode) ORDER BY name) FROM canvases),
    'entities', (SELECT jsonb_agg(jsonb_build_object('id', id, 'type', type, 'name', name, 'description', description,
      'metadata', metadata) ORDER BY name) FROM entities),
    'placements', (SELECT jsonb_agg(jsonb_build_object('canvas', canvas_id, 'entity', entity_id, 'x', x, 'y', y,
      'width', width, 'height', height) ORDER BY canvas_id, entity_id) FROM canvas_nodes),
    'connections', (SELECT jsonb_agg(jsonb_build_object('id', id, 'type', type, 'label', label, 'metadata', metadata))
      FROM connections),
    'canvasConnections', (SELECT jsonb_agg(jsonb_build_object('canvas', canvas_id, 'connection', connection_id,
      'bend', bend)) FROM canvas_connections),
    'events', (SELECT jsonb_agg(jsonb_build_object('id', id, 'action', action, 'target', target_id, 'metadata', metadata))
      FROM canvas_events)
  ) AS content
`);

describe("database upgrades", () => {
  it("keeps v0.1.0 content through every later migration", async () => {
    const scratch = await scratchDatabase("upgrade");
    try {
      await migrateDatabase(scratch.url, v010);
      const database = drizzle(scratch.url);
      try {
        await database.execute(seed);
        const before = (await database.execute(snapshot)).rows[0]?.content;
        expect(JSON.stringify(before)).toContain("Retries **twice**");

        await migrateDatabase(scratch.url);

        expect((await database.execute(snapshot)).rows[0]?.content).toEqual(before);
        // Drizzle skips a migration whose journal timestamp is not newer than the last applied one, so check that
        // every migration in the journal actually ran on the upgraded database.
        const applied = await database.execute(
          sql.raw("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"),
        );
        expect(applied.rows[0]?.count).toBe(readJournal().entries.length);
      } finally {
        await database.$client.end();
      }
    } finally {
      await scratch.drop();
    }
  });
});
