import type { Pool, PoolClient } from "pg";

export interface SingleInstanceClaim {
  readonly held: boolean;
  release(): Promise<void>;
}

type ClaimOptions = {
  key?: readonly [number, number];
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
};

// Fixed across processes and releases so every API competes for the same database claim.
// Two int4 keys: ASCII "WOOB" namespace, operation 1 (collaborative sync).
const productionKey = [0x574f4f42, 1] as const;

function beginClaim(pool: Pool, options: ClaimOptions = {}) {
  const key = options.key ?? productionKey;
  const log = options.log ?? console.error;
  let client: PoolClient | undefined;
  let held = false;
  let abandoned = false;
  let disposed = false;
  let settle: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    clearTimeout(timer);
    settle();
  };
  const dispose = () => {
    if (!client || disposed) return;
    disposed = true;
    try {
      client.release(true);
    } catch {
      // A disconnected or already released session needs no further cleanup.
    }
  };
  const lost = () => {
    abandoned = true;
    if (held) {
      held = false;
      log(
        "Lost the single-instance database claim. Collaborative document sync stays disabled until the API restarts.",
      );
    }
    dispose();
    finish();
  };
  const claim: SingleInstanceClaim = {
    get held() {
      return held;
    },
    async release() {
      held = false;
      abandoned = true;
      dispose();
      finish();
    },
  };
  const timer = setTimeout(() => {
    abandoned = true;
    held = false;
    dispose();
    log("Could not claim single-instance operation. Collaborative document sync stays disabled.", {
      message: "Timed out claiming single-instance operation.",
    });
    finish();
  }, options.timeoutMs ?? 10_000);
  timer.unref?.();
  const acquire = async () => {
    try {
      client = await pool.connect();
      client.on("error", lost);
      client.on("end", lost);
      if (abandoned) {
        dispose();
        return;
      }
      const result = await client.query<{ claimed: boolean }>(
        "SELECT pg_try_advisory_lock($1::int, $2::int) AS claimed",
        [...key],
      );
      if (abandoned) return;
      held = result.rows[0]?.claimed === true;
      if (!held) {
        dispose();
        log(
          "Another Wooble API instance holds the single-instance claim on this database. Collaborative document sync stays disabled. Run exactly one API replica (see docs/self-hosting.md).",
        );
      }
    } catch (error) {
      dispose();
      if (abandoned) return;
      // Driver messages can contain credentials or connection strings. Only retain a
      // recognised SQLSTATE/network code and a fixed message, never the raw error.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const safeCode =
        typeof code === "string" &&
        (/^[0-9A-Z]{5}$/.test(code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code))
          ? code
          : undefined;
      log("Could not claim single-instance operation. Collaborative document sync stays disabled.", {
        message: "Database connection or advisory lock query failed.",
        ...(safeCode ? { code: safeCode } : {}),
      });
    } finally {
      finish();
    }
  };
  void acquire();
  return { claim, ready: completed.then(() => claim) };
}

export function claimSingleInstance(pool: Pool, options: ClaimOptions = {}): Promise<SingleInstanceClaim> {
  return beginClaim(pool, options).ready;
}

let processClaim: SingleInstanceClaim | undefined;
let starting: Promise<SingleInstanceClaim> | undefined;

export function startSingleInstanceGate(pool: Pool, options?: ClaimOptions): Promise<SingleInstanceClaim> {
  if (!starting) {
    const acquisition = beginClaim(pool, options);
    processClaim = acquisition.claim;
    starting = acquisition.ready;
  }
  return starting;
}

export function collaborativeSyncAllowed(): boolean {
  return processClaim?.held ?? false;
}

export async function stopSingleInstanceGate(): Promise<void> {
  await processClaim?.release();
}
