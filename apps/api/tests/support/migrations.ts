import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const migrationsFolder = join(import.meta.dir, "../../../../packages/db/drizzle");

export type Journal = { entries: Array<{ idx: number; when: number; tag: string }> } & Record<string, unknown>;

export type ScratchDatabase = {
  /** Connection string pointing at the created database. */
  url: string;
  /** The database name this call created. */
  name: string;
  /**
   * Drops only the database this call created. Repeated/concurrent calls are safe; a failed drop can be retried
   * after the caller closes its connections. Never terminates other sessions.
   */
  drop: () => Promise<void>;
};

/** Every scratch database created here starts with this, so a leaked one is recognisable in `pg_database`. */
export const scratchDatabasePrefix = "wooble_p1_1_";
/** PostgreSQL truncates unquoted identifiers at `NAMEDATALEN - 1` bytes with only a NOTICE, so names must fit. */
const maxIdentifierBytes = 63;
/** `CREATE DATABASE` reports an already-taken name as SQLSTATE 42P04 (`duplicate_database`). */
const duplicateDatabaseCode = "42P04";
/** A taken name is regenerated and retried this many times before giving up. */
const maxCreateAttempts = 5;
const randomTokenBytes = 8;

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

/** Lowercases and replaces anything an unquoted identifier cannot hold. */
function identifierPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function assertScratchName(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected scratch database name ${name}`);
  if (Buffer.byteLength(name, "utf8") > maxIdentifierBytes)
    throw new Error(`Scratch database name ${name} exceeds the ${maxIdentifierBytes} byte identifier limit`);
  return name;
}

/**
 * The SQLSTATE behind a failed statement, read from the pg error `code` rather than the message text. Drizzle wraps
 * driver errors in `DrizzleQueryError`, so the code sits on the `cause` chain; a bare driver call carries it directly.
 */
function sqlState(error: unknown, depth = 4): string | undefined {
  for (let level = 0; level < depth; level += 1) {
    if (typeof error !== "object" || error === null) return undefined;
    if ("code" in error && typeof error.code === "string") return error.code;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True only for a PostgreSQL `duplicate_database` error. */
function isDuplicateDatabase(error: unknown): boolean {
  return sqlState(error) === duplicateDatabaseCode;
}

/** A short random token, so two concurrent runs never aim at the same name. */
function randomToken(): string {
  return randomBytes(randomTokenBytes).toString("hex");
}

/**
 * Builds `wooble_p1_1_<base>_<suffix>_<token>`, always a legal unquoted identifier of at most 63 bytes. The base name
 * only says which instance is in play, so it gives up room first; long caller suffixes are also bounded.
 */
export function scratchDatabaseName(baseName: string, suffix: string, token: string): string {
  const base = identifierPart(baseName);
  const tag = identifierPart(suffix);
  const random = identifierPart(token);
  if (!base) throw new Error("DATABASE_URL must name a database");
  if (!random) throw new Error("A scratch database name needs a non-empty random token");
  // Room for the whole name bar the prefix and the random token, minus the two separators.
  const room = maxIdentifierBytes - scratchDatabasePrefix.length - random.length - 2;
  if (room < 2) throw new Error(`Random token ${random} leaves no room for the scratch database name`);
  const tagLength = Math.min(tag.length, Math.floor(room / 2));
  const baseLength = Math.min(base.length, room - tagLength);
  const name = `${scratchDatabasePrefix}${base.slice(0, baseLength)}_${tag.slice(0, tagLength)}_${random}`;
  return assertScratchName(name);
}

/**
 * Creates an empty database beside the test database under a name unique to this run. Never point DATABASE_URL at a
 * database you want to keep: the base name is copied into the scratch name, but nothing is ever dropped before a
 * `CREATE DATABASE` of this run has succeeded, and `drop()` only ever removes the name this call created.
 *
 * `options.token` lets tests deterministically exercise collisions; production test runs use cryptographic randomness.
 */
export async function scratchDatabase(
  suffix: string,
  options: { token?: () => string } = {},
): Promise<ScratchDatabase> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must point at an isolated test database");
  const url = new URL(process.env.DATABASE_URL);
  const baseName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  // Each statement gets its own short-lived pool on the admin database, so the harness holds no connection by the
  // time a `DROP DATABASE` runs and never force-terminates a session it does not own.
  const run = async (statement: string) => {
    const database = drizzle(admin.toString());
    try {
      await database.execute(sql.raw(statement));
    } finally {
      await database.$client.end();
    }
  };
  // Ownership is only set once this run's own `CREATE DATABASE` succeeded, so `drop()` can never name a peer database.
  let owned: string | undefined;
  for (let attempt = 0; attempt < maxCreateAttempts; attempt += 1) {
    const candidate = scratchDatabaseName(baseName, suffix, (options.token ?? randomToken)());
    try {
      await run(`CREATE DATABASE ${candidate}`);
      owned = candidate;
      break;
    } catch (error) {
      if (!isDuplicateDatabase(error)) throw error;
    }
  }
  if (!owned) throw new Error(`Could not create a scratch database in ${maxCreateAttempts} attempts`);
  url.pathname = `/${owned}`;
  const scratchUrl = url.toString();
  let dropping: Promise<void> | undefined;
  return {
    url: scratchUrl,
    name: owned,
    drop: () => {
      if (dropping) return dropping;
      const name = owned;
      if (!name) return Promise.resolve();
      dropping = run(`DROP DATABASE IF EXISTS ${name}`)
        .then(() => {
          // Only a successful drop spends the handle. A busy database can be cleaned up after its sessions close.
          owned = undefined;
        })
        .finally(() => {
          dropping = undefined;
        });
      return dropping;
    },
  };
}
