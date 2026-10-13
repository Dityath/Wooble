import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const migrationsFolder = join(import.meta.dir, "../../../../packages/db/drizzle");

export type Journal = { entries: Array<{ idx: number; when: number; tag: string }> } & Record<string, unknown>;

export function readJournal(folder = migrationsFolder): Journal {
  return JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as Journal;
}

/**
 * Applies the checked-in migrations to a database the way `bun db:migrate` does. With `lastTag`, it stops after that
 * migration by migrating from a temporary copy of the folder whose journal ends there; checked-in files are untouched.
 */
export async function migrateDatabase(databaseUrl: string, lastTag?: string) {
  let folder = migrationsFolder;
  let copy: string | undefined;
  if (lastTag) {
    const journal = readJournal();
    const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
    if (end < 0) throw new Error(`Unknown migration ${lastTag}`);
    const entries = journal.entries.slice(0, end + 1);
    copy = mkdtempSync(join(tmpdir(), "wooble-migrations-"));
    mkdirSync(join(copy, "meta"));
    for (const entry of entries)
      copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(copy, `${entry.tag}.sql`));
    writeFileSync(join(copy, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    folder = copy;
  }
  const database = drizzle(databaseUrl);
  try {
    await migrate(database, { migrationsFolder: folder });
  } finally {
    await database.$client.end();
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
}

/** Creates an empty database beside the test database. Never point DATABASE_URL at a database you want to keep. */
export async function scratchDatabase(suffix: string) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at an isolated test database");
  const url = new URL(process.env.DATABASE_URL);
  const name = `${url.pathname.slice(1)}_${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected scratch database name ${name}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const run = async (statement: string) => {
    const database = drizzle(admin.toString());
    try {
      await database.execute(sql.raw(statement));
    } finally {
      await database.$client.end();
    }
  };
  await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await run(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}
