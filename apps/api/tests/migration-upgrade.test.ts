import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { ScratchDatabase } from "./support/migrations";
import {
  migrateDatabase,
  readJournal,
  scratchDatabase,
  scratchDatabasePrefix,
  scratchDatabaseName,
} from "./support/migrations";

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

describe("canvas event sequence backfill", () => {
  it("orders seq by (created_at, id) and gives later inserts a higher seq", async () => {
    const scratch = await scratchDatabase("eventseq");
    try {
      await migrateDatabase(scratch.url, v010);
      const database = drizzle(scratch.url);
      try {
        const event = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
        await database.execute(
          sql.raw(`
          INSERT INTO users (id, email, name, password_hash) VALUES ('${ids.user}', 'seq-owner@example.test', 'Seq Owner', 'scrypt$fictional');
          INSERT INTO workspaces (id, name) VALUES ('${ids.workspace}', 'Seq workspace');
          INSERT INTO canvases (id, workspace_id, name) VALUES ('${ids.home}', '${ids.workspace}', 'Home');
          -- Physical insert order is newest first; the two oldest share a timestamp, so id breaks the tie.
          INSERT INTO canvas_events (id, canvas_id, actor_name, action, target_type, created_at) VALUES
            ('${event(1)}', '${ids.home}', 'Seq Owner', 'canvas.updated', 'canvas', '2026-03-04T00:00:00Z'),
            ('${event(2)}', '${ids.home}', 'Seq Owner', 'canvas.updated', 'canvas', '2026-03-03T00:00:00Z'),
            ('${event(4)}', '${ids.home}', 'Seq Owner', 'canvas.updated', 'canvas', '2026-03-01T00:00:00Z'),
            ('${event(3)}', '${ids.home}', 'Seq Owner', 'canvas.updated', 'canvas', '2026-03-01T00:00:00Z');
        `),
        );

        await migrateDatabase(scratch.url);

        const bySeq = await database.execute(sql.raw("SELECT id, seq FROM canvas_events ORDER BY seq ASC"));
        const byTime = await database.execute(sql.raw("SELECT id FROM canvas_events ORDER BY created_at ASC, id ASC"));
        expect(bySeq.rows.map((row) => row.id)).toEqual([event(3), event(4), event(2), event(1)]);
        expect(bySeq.rows.map((row) => row.id)).toEqual(byTime.rows.map((row) => row.id));
        expect(bySeq.rows.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4]);

        await database.execute(
          sql.raw(`INSERT INTO canvas_events (id, canvas_id, actor_name, action, target_type, created_at)
            VALUES ('${event(5)}', '${ids.home}', 'Seq Owner', 'canvas.updated', 'canvas', '2020-01-01T00:00:00Z')`),
        );
        const added = await database.execute(sql.raw(`SELECT seq FROM canvas_events WHERE id = '${event(5)}'`));
        expect(Number(added.rows[0]?.seq)).toBeGreaterThan(4);
      } finally {
        await database.$client.end();
      }
    } finally {
      await scratch.drop();
    }
  });

  it("migrates an empty table and numbers the first event 1", async () => {
    const scratch = await scratchDatabase("eventseq0");
    try {
      await migrateDatabase(scratch.url);
      const database = drizzle(scratch.url);
      try {
        await database.execute(
          sql.raw(`
          INSERT INTO users (id, email, name, password_hash) VALUES ('${ids.user}', 'seq-empty@example.test', 'Seq Empty', 'scrypt$fictional');
          INSERT INTO workspaces (id, name) VALUES ('${ids.workspace}', 'Empty workspace');
          INSERT INTO canvases (id, workspace_id, name) VALUES ('${ids.home}', '${ids.workspace}', 'Home');
          INSERT INTO canvas_events (canvas_id, actor_name, action, target_type) VALUES ('${ids.home}', 'Seq Empty', 'canvas.updated', 'canvas');
        `),
        );
        const rows = await database.execute(sql.raw("SELECT seq FROM canvas_events"));
        expect(rows.rows.map((row) => Number(row.seq))).toEqual([1]);
      } finally {
        await database.$client.end();
      }
    } finally {
      await scratch.drop();
    }
  });
});

/** Connection string for another database on the same instance as DATABASE_URL. */
function urlFor(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${name}`;
  return url.toString();
}

/** The admin database, used only for statements about other databases. */
function admin() {
  return drizzle(urlFor("postgres"));
}

/** Runs one admin statement on its own pool, closed before the statement resolves. */
async function adminStatement(statement: string): Promise<void> {
  const database = admin();
  try {
    await database.execute(sql.raw(statement));
  } finally {
    await database.$client.end();
  }
}

/** The scratch databases currently on the instance, so a leaked or destroyed one is visible. */
async function scratchNames(): Promise<string[]> {
  const database = admin();
  try {
    const result = await database.execute(
      sql.raw("SELECT datname FROM pg_database WHERE starts_with(datname, 'wooble_p1_1_') ORDER BY datname"),
    );
    return result.rows.map((row) => String(row.datname));
  } finally {
    await database.$client.end();
  }
}

/** Whether a database with exactly this name exists, whatever its prefix. */
async function databaseExists(name: string): Promise<boolean> {
  const database = admin();
  try {
    const result = await database.execute(sql`SELECT 1 FROM pg_database WHERE datname = ${name}`);
    return result.rows.length === 1;
  } finally {
    await database.$client.end();
  }
}

/** Runs a read on a scratch database through a pool that is closed before it resolves. */
async function query(databaseUrl: string, statement: string): Promise<unknown[]> {
  const database = drizzle(databaseUrl);
  try {
    return (await database.execute(sql.raw(statement))).rows;
  } finally {
    await database.$client.end();
  }
}

const publicTables = (databaseUrl: string) =>
  query(databaseUrl, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename").then((rows) =>
    rows.map((row) => (row as { tablename: string }).tablename),
  );

/** Two harnesses created at the same time, with every one of them cleaned up whatever the body does. */
async function withParallelHarnesses(
  body: (first: ScratchDatabase, second: ScratchDatabase) => Promise<void>,
): Promise<void> {
  const harnesses: ScratchDatabase[] = [];
  const results = await Promise.allSettled(
    [scratchDatabase("parallel"), scratchDatabase("parallel")].map((pending) =>
      pending.then((scratch) => {
        harnesses.push(scratch);
        return scratch;
      }),
    ),
  );
  const failed = results.find((result) => result.status === "rejected");
  try {
    if (failed?.status === "rejected") throw failed.reason;
    const [first, second] = harnesses as [ScratchDatabase, ScratchDatabase];
    await body(first, second);
  } finally {
    for (const harness of harnesses) await harness.drop();
  }
}

describe("canvas member origin backfill", () => {
  it("treats existing viewers of link-shared canvases as link members and everyone else as invited", async () => {
    const scratch = await scratchDatabase("memberorigin");
    try {
      await migrateDatabase(scratch.url, v010);
      const database = drizzle(scratch.url);
      try {
        const user = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
        await database.execute(
          sql.raw(`
          INSERT INTO users (id, email, name, password_hash) VALUES
            ('${user(1)}', 'origin-viewer@example.test', 'Origin Viewer', 'scrypt$fictional'),
            ('${user(2)}', 'origin-editor@example.test', 'Origin Editor', 'scrypt$fictional'),
            ('${user(3)}', 'origin-invited@example.test', 'Origin Invited', 'scrypt$fictional');
          INSERT INTO workspaces (id, name) VALUES ('${ids.workspace}', 'Origin workspace');
          INSERT INTO canvases (id, workspace_id, name, share_mode) VALUES
            ('${ids.home}', '${ids.workspace}', 'Home', 'restricted'),
            ('${ids.board}', '${ids.workspace}', 'Board', 'link');
          INSERT INTO canvas_members (canvas_id, user_id, role) VALUES
            ('${ids.board}', '${user(1)}', 'viewer'),
            ('${ids.board}', '${user(2)}', 'editor'),
            ('${ids.home}', '${user(3)}', 'viewer');
        `),
        );

        await migrateDatabase(scratch.url);

        const rows = await database.execute(
          sql.raw("SELECT canvas_id, user_id, role, origin FROM canvas_members ORDER BY user_id"),
        );
        // Only a viewer of a canvas that is shared by link now could have joined through the link (#62).
        expect(rows.rows).toEqual([
          { canvas_id: ids.board, user_id: user(1), role: "viewer", origin: "link" },
          { canvas_id: ids.board, user_id: user(2), role: "editor", origin: "invited" },
          { canvas_id: ids.home, user_id: user(3), role: "viewer", origin: "invited" },
        ]);
      } finally {
        await database.$client.end();
      }
    } finally {
      await scratch.drop();
    }
  });
});

describe("scratch database safety", () => {
  it("keeps two harnesses running at the same time independent", async () => {
    await withParallelHarnesses(async (first, second) => {
      // Both were created before either was dropped, so their names have to differ.
      expect(first.name).not.toBe(second.name);
      await Promise.all([migrateDatabase(first.url), migrateDatabase(second.url)]);

      const names = await scratchNames();
      expect(names).toContain(first.name);
      expect(names).toContain(second.name);

      const expected = ["canvas_events", "entities", "users", "workspace_members"];
      for (const tables of [await publicTables(first.url), await publicTables(second.url)]) {
        for (const table of expected) expect(tables).toContain(table);
      }

      // Dropping one must leave the other reachable, with its schema and its rows.
      await query(
        second.url,
        "INSERT INTO users (id, email, name, password_hash) VALUES ('00000000-0000-4000-8000-0000000000ff', 'survivor@example.test', 'Survivor', 'scrypt$fictional')",
      );
      // An open session on the second database must survive the drop of the first.
      const open = drizzle(second.url);
      try {
        await open.execute(sql.raw("SELECT 1"));
        await first.drop();
        expect((await open.execute(sql.raw("SELECT count(*)::int AS n FROM users"))).rows).toEqual([{ n: 1 }]);
      } finally {
        await open.$client.end();
      }

      expect(await scratchNames()).not.toContain(first.name);
      expect(await scratchNames()).toContain(second.name);
      const survivors = await publicTables(second.url);
      for (const table of expected) expect(survivors).toContain(table);
      expect(await query(second.url, "SELECT email FROM users WHERE email = 'survivor@example.test'")).toEqual([
        { email: "survivor@example.test" },
      ]);
    });
  });

  it("refuses to drop a database with an open session, without ending it, and drops it once the session closes", async () => {
    const scratch = await scratchDatabase("busy");
    const open = drizzle(scratch.url);
    let closed = false;
    try {
      await open.execute(sql.raw("SELECT 1"));
      // The documented behavior: no FORCE, so a busy database is not dropped and its session is left alone.
      await expect(scratch.drop()).rejects.toThrow();
      expect(await scratchNames()).toContain(scratch.name);
      expect((await open.execute(sql.raw("SELECT 1 AS one"))).rows).toEqual([{ one: 1 }]);

      await open.$client.end();
      closed = true;
      await scratch.drop();
      expect(await scratchNames()).not.toContain(scratch.name);
    } finally {
      if (!closed) await open.$client.end();
      await scratch.drop();
    }
    // PostgreSQL waits about five seconds for a busy database's sessions before refusing the drop.
  }, 30_000);

  it("never drops a database it did not create", async () => {
    // `<database>_upgrade` is the fixed name the pre-fix harness used for the suffix below, so it is exactly what a
    // preemptive `DROP DATABASE` used to destroy. The second sentinel sits in the harness's own prefix namespace.
    const base = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    const sentinels = [`${base}_upgrade`, `${scratchDatabasePrefix}${base}_sentinel_0000`];
    const created: string[] = [];
    try {
      for (const sentinel of sentinels) {
        await adminStatement(`CREATE DATABASE ${sentinel}`);
        created.push(sentinel);
        await query(urlFor(sentinel), "CREATE TABLE notes (id int PRIMARY KEY, body text NOT NULL)");
        await query(
          urlFor(sentinel),
          "INSERT INTO notes (id, body) VALUES (1, 'Written before any scratch database existed')",
        );
      }

      // Three full create/migrate/drop cycles against the same suffix the sentinel name was built from.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const scratch = await scratchDatabase("upgrade");
        try {
          await migrateDatabase(scratch.url);
        } finally {
          await scratch.drop();
          // A second drop is a no-op: the handle is spent once it has dropped its database.
          await scratch.drop();
        }
      }

      for (const sentinel of sentinels) {
        // Looked up by exact name: `scratchNames()` only lists the harness's prefix, which the `_upgrade` sentinel
        // lacks unless DATABASE_URL's own database name happens to start with it.
        expect(await databaseExists(sentinel)).toBe(true);
        expect(await query(urlFor(sentinel), "SELECT id, body FROM notes ORDER BY id")).toEqual([
          { id: 1, body: "Written before any scratch database existed" },
        ]);
      }
    } finally {
      // The test's own databases, dropped by name: never through the harness under test.
      for (const sentinel of created) await adminStatement(`DROP DATABASE IF EXISTS ${sentinel} WITH (FORCE)`);
    }
  }, 30_000);

  it("regenerates a taken name instead of dropping what is already there", async () => {
    const base = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    const existing = scratchDatabaseName(base, "taken", "aaaa0000");
    await adminStatement(`CREATE DATABASE ${existing}`);
    try {
      await query(urlFor(existing), "CREATE TABLE kept (id int PRIMARY KEY)");
      await query(urlFor(existing), "INSERT INTO kept (id) VALUES (1)");

      // The first candidate collides with `existing`; later ones are fresh.
      const tokens = ["aaaa0000", "bbbb1111", "cccc2222"];
      let calls = 0;
      const scratch = await scratchDatabase("taken", { token: () => tokens[calls++] ?? "dddd3333" });
      try {
        expect(calls).toBe(2);
        expect(scratch.name).not.toBe(existing);
        expect(scratch.name).toBe(scratchDatabaseName(base, "taken", "bbbb1111"));
        expect(await scratchNames()).toContain(scratch.name);

        // The pre-existing database kept both its name and its contents.
        expect(await scratchNames()).toContain(existing);
        expect(await query(urlFor(existing), "SELECT id FROM kept ORDER BY id")).toEqual([{ id: 1 }]);
      } finally {
        await scratch.drop();
      }

      // And dropping what this run created leaves the taken database alone.
      expect(await scratchNames()).not.toContain(scratch.name);
      expect(await query(urlFor(existing), "SELECT id FROM kept ORDER BY id")).toEqual([{ id: 1 }]);
    } finally {
      await adminStatement(`DROP DATABASE IF EXISTS ${existing} WITH (FORCE)`);
    }
  });

  it("gives up after bounded attempts when every name is taken, without dropping anything", async () => {
    const base = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    const existing = scratchDatabaseName(base, "full", "eeee4444");
    await adminStatement(`CREATE DATABASE ${existing}`);
    try {
      let calls = 0;
      await expect(
        scratchDatabase("full", {
          token: () => {
            calls += 1;
            return "eeee4444";
          },
        }),
      ).rejects.toThrow(/attempts/);
      expect(calls).toBeGreaterThan(1);
      expect(calls).toBeLessThanOrEqual(10);
      expect(await scratchNames()).toContain(existing);
    } finally {
      await adminStatement(`DROP DATABASE IF EXISTS ${existing} WITH (FORCE)`);
    }
  });

  it("bounds the generated name even when the test database name is long", () => {
    const longName = `wooble_p1_1_${"x".repeat(200)}`;
    const first = scratchDatabaseName(longName, "upgrade", "0123456789");
    const second = scratchDatabaseName(longName, "upgrade", "fedcba9876");

    for (const name of [first, second]) {
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(name.startsWith("wooble_p1_1_")).toBe(true);
      expect(name).toContain("_upgrade_");
    }

    // Same database and suffix, different randomness.
    expect(first).not.toBe(second);
    expect(first.slice(0, -10)).toBe(second.slice(0, -10));
  });
});
