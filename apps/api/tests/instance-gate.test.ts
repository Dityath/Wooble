import { describe, expect, it } from "bun:test";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { Client, Pool } from "pg";
import {
  claimSingleInstance,
  type ClaimClient,
  collaborativeSyncAllowed,
  startSingleInstanceGate,
  stopSingleInstanceGate,
  type SingleInstanceClaim,
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
  const deadline = Date.now() + 5_000;
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
    const claims: SingleInstanceClaim[] = [];
    const losses: string[] = [];
    try {
      expect(collaborativeSyncAllowed()).toBe(false);
      const first = await startSingleInstanceGate(() => new Client(pool.options), {
        key,
        log: (message) => losses.push(message),
      });
      claims.push(first);
      expect(first.held).toBe(true);
      expect(collaborativeSyncAllowed()).toBe(true);
      const second = await claimSingleInstance(() => new Client(pool.options), {
        key,
        log: (message) => messages.push(message),
      });
      claims.push(second);
      expect(second.held).toBe(false);
      expect(messages).toEqual([conflict]);
      const holder = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted",
        [key[0] >>> 0, key[1]],
      );
      expect(holder.rows).toHaveLength(1);
      await pool.query("SELECT pg_terminate_backend($1)", [holder.rows[0]?.pid]);
      await waitUntil(() => !collaborativeSyncAllowed());
      await Bun.sleep(50);
      expect(collaborativeSyncAllowed()).toBe(false);
      expect(losses).toEqual([lost]);
      await second.release();
      await Promise.all([stopSingleInstanceGate(), first.release(), first.release()]);
      expect(first.held).toBe(false);
      expect(collaborativeSyncAllowed()).toBe(false);
      const next = await claimSingleInstance(() => new Client(pool.options), { key });
      claims.push(next);
      try {
        expect(next.held).toBe(true);
      } finally {
        await next.release();
      }
    } finally {
      try {
        await Promise.all(claims.map((claim) => claim.release()));
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
    let first: SingleInstanceClaim | undefined;
    let next: SingleInstanceClaim | undefined;
    try {
      first = await claimSingleInstance(() => new Client(pool.options), {
        key,
        log: (message) => messages.push(message),
      });
      expect(first.held).toBe(true);
      const holder = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted",
        [key[0] >>> 0, key[1]],
      );
      expect(holder.rows).toHaveLength(1);
      await pool.query("SELECT pg_terminate_backend($1)", [holder.rows[0]?.pid]);
      await waitUntil(() => !first?.held);
      next = await claimSingleInstance(() => new Client(pool.options), { key });
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
        await next?.release();
      } finally {
        await pool.end();
      }
    }
  });

  it("permits a new holder after graceful release", async () => {
    const pool = testPool();
    const key = testKey();
    let first: SingleInstanceClaim | undefined;
    let next: SingleInstanceClaim | undefined;
    try {
      first = await claimSingleInstance(() => new Client(pool.options), { key });
      expect(first.held).toBe(true);
      await first.release();
      expect(first.held).toBe(false);
      const deadline = Date.now() + 5_000;
      while (true) {
        next = await claimSingleInstance(() => new Client(pool.options), { key, log: () => {} });
        if (next.held) break;
        await next.release();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for graceful claim release.");
        await Bun.sleep(10);
      }
      expect(next.held).toBe(true);
    } finally {
      await first?.release();
      await next?.release();
      await pool.end();
    }
  }, 15_000);

  it("sanitizes a refused connection without exposing credentials", async () => {
    const password = "secret-test-password";
    const pool = new Pool({
      connectionString: `postgres://wooble:${password}@127.0.0.1:1/none`,
      connectionTimeoutMillis: 100,
    });
    const logs: unknown[][] = [];
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(() => new Client(pool.options), {
        key: testKey(),
        log: (...args) => logs.push(args),
      });
      expect(claim.held).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.[0]).toBe(
        "Could not claim single-instance operation. Collaborative document sync stays disabled.",
      );
      expect(logs[0]?.[1]).toEqual({
        message: "Database connection or advisory lock query failed.",
        code: "ECONNREFUSED",
      });
      expect(Object.getPrototypeOf(logs[0]?.[1])).toBe(Object.prototype);
      expect(logs[0]?.[1]).not.toBeInstanceOf(Error);
      expect(JSON.stringify(logs)).not.toContain(password);
      expect(JSON.stringify(logs)).not.toContain("postgres://");
      await claim.release();
      await claim.release();
    } finally {
      await claim?.release();
      await pool.end();
    }
  }, 10_000);
});

const failed = "Could not claim single-instance operation. Collaborative document sync stays disabled.";

function fakeClient(
  query: () => Promise<{ rows: { claimed: boolean }[] }>,
  connect: () => Promise<void> = async () => {},
) {
  const releases: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    connect,
    query,
    end: () => {
      releases.push(true);
      return Promise.resolve();
    },
  }) as unknown as ClaimClient;
  return { client, releases };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("fake client gate", () => {
  it("sanitizes errors with secret messages, stacks, and unknown codes", async () => {
    const error = Object.assign(new Error("postgres://wooble:secret-test-password@db.example.test/wooble"), {
      code: "EWEIRD",
    });
    const logs: unknown[][] = [];
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(
        () =>
          fakeClient(
            async () => ({ rows: [] }),
            () => Promise.reject(error),
          ).client,
        {
          log: (...args) => logs.push(args),
        },
      );
      expect(claim.held).toBe(false);
      expect(logs).toEqual([[failed, { message: "Database connection or advisory lock query failed." }]]);
      expect(Object.getPrototypeOf(logs[0]?.[1])).toBe(Object.prototype);
      expect(logs[0]?.[1]).not.toBeInstanceOf(Error);
      expect(logs[0]?.[1]).not.toHaveProperty("code");
      expect(JSON.stringify(logs)).not.toContain("secret-test-password");
    } finally {
      await claim?.release();
    }
  });

  it("timeout bounds connecting and destroys a late fake client", async () => {
    const connection = deferred<void>();
    let queries = 0;
    const { client, releases } = fakeClient(
      async () => {
        queries += 1;
        return { rows: [{ claimed: true }] };
      },
      () => connection.promise,
    );
    const logs: unknown[][] = [];
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(() => client, {
        timeoutMs: 50,
        log: (...args) => logs.push(args),
      });
      expect(claim.held).toBe(false);
      expect(logs).toEqual([[failed, { message: "Timed out claiming single-instance operation." }]]);
      connection.resolve();
      await connection.promise;
      await Promise.resolve();
      expect(releases).toEqual([true]);
      expect(queries).toBe(0);
      expect(claim.held).toBe(false);
    } finally {
      connection.resolve();
      await claim?.release();
    }
  });

  it("timeout bounds a stalled fake lock query and ignores its late result", async () => {
    let resolveQuery!: (result: { rows: { claimed: boolean }[] }) => void;
    const { client, releases } = fakeClient(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const logs: unknown[][] = [];
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(() => client, {
        timeoutMs: 50,
        log: (...args) => logs.push(args),
      });
      expect(claim.held).toBe(false);
      expect(releases).toEqual([true]);
      expect(logs).toEqual([[failed, { message: "Timed out claiming single-instance operation." }]]);
      resolveQuery({ rows: [{ claimed: true }] });
      await Promise.resolve();
      expect(claim.held).toBe(false);
      expect(releases).toEqual([true]);
      expect(logs).toHaveLength(1);
    } finally {
      resolveQuery({ rows: [{ claimed: true }] });
      await claim?.release();
    }
  });

  it("fake process gate never checks out the shared pool and stops while connection is pending", async () => {
    // Isolate the process singleton from the database-backed process-gate test.
    const modulePath = "../src/lib/instance-gate.ts";
    const gate: typeof import("../src/lib/instance-gate") = await import(`${modulePath}?pending-stop`);
    const connection = deferred<void>();
    let queries = 0;
    const { client, releases } = fakeClient(
      async () => {
        queries += 1;
        return { rows: [{ claimed: true }] };
      },
      () => connection.promise,
    );
    const logs: unknown[][] = [];
    let claim: SingleInstanceClaim | undefined;
    const pool = {
      options: { connectionString: "postgres://example.test/fictional" },
      connect: () => {
        throw new Error("The shared pool must never be checked out");
      },
    };
    const disconnected = deferred<void>();
    client.end = () => {
      releases.push(true);
      return disconnected.promise;
    };
    const pending = gate.startSingleInstanceGate(
      () => {
        expect(pool.options.connectionString).toBe("postgres://example.test/fictional");
        return client;
      },
      { timeoutMs: 10_000, log: (...args) => logs.push(args) },
    );
    try {
      expect(gate.collaborativeSyncAllowed()).toBe(false);
      await gate.stopSingleInstanceGate();
      claim = await pending;
      expect(releases).toEqual([true]);
      expect(queries).toBe(0);
      connection.resolve();
      await connection.promise;
      await Promise.resolve();
      expect(releases).toEqual([true]);
      expect(claim.held).toBe(false);
      expect(gate.collaborativeSyncAllowed()).toBe(false);
      expect(logs).toEqual([]);
      expect(queries).toBe(0);
    } finally {
      connection.resolve();
      await gate.stopSingleInstanceGate();
      await claim?.release();
    }
  });

  it("release remains safe when a fake client throws synchronously during disposal", async () => {
    const { client } = fakeClient(async () => ({ rows: [{ claimed: true }] }));
    let releases = 0;
    client.end = () => {
      releases += 1;
      throw new Error("Already disconnected");
    };
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(() => client);
      await claim.release();
      await claim.release();
      expect(claim.held).toBe(false);
      expect(releases).toBe(1);
    } finally {
      await claim?.release();
    }
  });

  it("release destroys the fake session once without a potentially stalled unlock query", async () => {
    let queries = 0;
    const { client, releases } = fakeClient(() => {
      queries += 1;
      return queries === 1 ? Promise.resolve({ rows: [{ claimed: true }] }) : new Promise(() => {});
    });
    const disconnected = deferred<void>();
    client.end = () => {
      releases.push(true);
      return disconnected.promise;
    };
    let claim: SingleInstanceClaim | undefined;
    try {
      claim = await claimSingleInstance(() => client);
      expect(claim.held).toBe(true);
      await claim.release();
      await claim.release();
      expect(claim.held).toBe(false);
      expect(releases).toEqual([true]);
      expect(queries).toBe(1);
    } finally {
      await claim?.release();
    }
  }, 10_000);
});
