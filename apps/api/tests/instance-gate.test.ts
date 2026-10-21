import { describe, expect, it } from "bun:test";
import { randomInt } from "node:crypto";
import { Pool } from "pg";
import {
  claimSingleInstance,
  collaborativeSyncAllowed,
  startSingleInstanceGate,
  stopSingleInstanceGate,
} from "../src/lib/instance-gate";

const conflict =
  "Another Wooble API instance holds the single-instance claim on this database. Collaborative document sync stays disabled. Run exactly one API replica (see docs/self-hosting.md).";
const lost =
  "Lost the single-instance database claim. Collaborative document sync stays disabled until the API restarts.";

function testKey(): readonly [number, number] {
  // Negative namespace cannot collide with the positive production namespace.
  return [-randomInt(1, 0x7fffffff), randomInt(1, 0x7fffffff)];
}

function testPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Instance gate integration tests require DATABASE_URL to be set.");
  return new Pool({ connectionString, connectionTimeoutMillis: 1_000 });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for database claim loss.");
    await Bun.sleep(10);
  }
}

describe("single-instance gate", () => {
  it("excludes another connection, exposes process state, and releases idempotently", async () => {
    const pool = testPool();
    const key = testKey();
    const messages: string[] = [];
    try {
      expect(collaborativeSyncAllowed()).toBe(false);
      const first = await startSingleInstanceGate(pool, { key });
      expect(first.held).toBe(true);
      expect(collaborativeSyncAllowed()).toBe(true);
      const second = await claimSingleInstance(pool, { key, log: (message) => messages.push(message) });
      expect(second.held).toBe(false);
      expect(messages).toEqual([conflict]);
      await second.release();
      await Promise.all([stopSingleInstanceGate(), first.release(), first.release()]);
      expect(first.held).toBe(false);
      expect(collaborativeSyncAllowed()).toBe(false);
      const next = await claimSingleInstance(pool, { key });
      try {
        expect(next.held).toBe(true);
      } finally {
        await next.release();
      }
    } finally {
      try {
        await stopSingleInstanceGate();
      } finally {
        await pool.end();
      }
    }
  });

  it("loses its claim once on backend termination and permits a new holder", async () => {
    const pool = testPool();
    const key = testKey();
    const messages: string[] = [];
    let first: Awaited<ReturnType<typeof claimSingleInstance>> | undefined;
    try {
      first = await claimSingleInstance(pool, { key, log: (message) => messages.push(message) });
      expect(first.held).toBe(true);
      const holder = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted",
        [key[0] >>> 0, key[1]],
      );
      expect(holder.rows).toHaveLength(1);
      await pool.query("SELECT pg_terminate_backend($1)", [holder.rows[0]?.pid]);
      await waitUntil(() => !first?.held);
      const next = await claimSingleInstance(pool, { key });
      try {
        expect(next.held).toBe(true);
        await first.release();
        await first.release();
        expect(messages).toEqual([lost]);
      } finally {
        await next.release();
      }
    } finally {
      try {
        await first?.release();
      } finally {
        await pool.end();
      }
    }
  });

  it("fails closed without exposing credentials when the database cannot be reached", async () => {
    const password = "secret-test-password";
    const pool = new Pool({
      connectionString: `postgres://wooble:${password}@127.0.0.1:1/none`,
      connectionTimeoutMillis: 100,
    });
    const logs: unknown[][] = [];
    try {
      const claim = await claimSingleInstance(pool, { key: testKey(), log: (...args) => logs.push(args) });
      expect(claim.held).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.[0]).toBe(
        "Could not claim single-instance operation. Collaborative document sync stays disabled.",
      );
      expect(logs[0]?.[1]).toEqual(expect.objectContaining({ message: expect.any(String) }));
      expect(JSON.stringify(logs)).not.toContain(password);
      expect(JSON.stringify(logs)).not.toContain("postgres://");
      await claim.release();
      await claim.release();
    } finally {
      await pool.end();
    }
  });
});
