import type { Pool, PoolClient } from "pg";

export interface SingleInstanceClaim {
  readonly held: boolean;
  release(): Promise<void>;
}

type ClaimOptions = {
  key?: readonly [number, number];
  log?: (message: string, error?: unknown) => void;
};

// Fixed across processes and releases so every API competes for the same database claim.
// Two int4 keys: ASCII "WOOB" namespace, operation 1 (collaborative sync).
const productionKey = [0x574f4f42, 1] as const;

export async function claimSingleInstance(pool: Pool, options: ClaimOptions = {}): Promise<SingleInstanceClaim> {
  const key = options.key ?? productionKey;
  const log = options.log ?? console.error;
  let client: PoolClient | undefined;
  let held = false;
  let disconnected = false;
  let disposed = false;
  let releasing: Promise<void> | undefined;
  const dispose = () => {
    if (!client || disposed) return;
    disposed = true;
    client.release(true);
  };
  const lost = () => {
    disconnected = true;
    if (held) {
      held = false;
      log(
        "Lost the single-instance database claim. Collaborative document sync stays disabled until the API restarts.",
      );
    }
    dispose();
  };
  const claim: SingleInstanceClaim = {
    get held() {
      return held;
    },
    release() {
      if (releasing) return releasing;
      held = false;
      releasing = (async () => {
        try {
          if (client && !disposed) await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [...key]);
        } catch {
          // A dead session has already relinquished its locks; always discard it.
        } finally {
          dispose();
        }
      })();
      return releasing;
    },
  };
  try {
    client = await pool.connect();
    client.on("error", lost);
    client.on("end", lost);
    const result = await client.query<{ claimed: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS claimed",
      [...key],
    );
    if (disconnected) return claim;
    held = result.rows[0]?.claimed === true;
    if (!held) {
      dispose();
      log(
        "Another Wooble API instance holds the single-instance claim on this database. Collaborative document sync stays disabled. Run exactly one API replica (see docs/self-hosting.md).",
      );
    }
  } catch (error) {
    dispose();
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
  }
  return claim;
}

let processClaim: SingleInstanceClaim | undefined;
let starting: Promise<SingleInstanceClaim> | undefined;

export function startSingleInstanceGate(pool: Pool, options?: ClaimOptions): Promise<SingleInstanceClaim> {
  starting ??= claimSingleInstance(pool, options).then((claim) => {
    processClaim = claim;
    return claim;
  });
  return starting;
}

export function collaborativeSyncAllowed(): boolean {
  return processClaim?.held ?? false;
}

export async function stopSingleInstanceGate(): Promise<void> {
  await (await starting)?.release();
}
