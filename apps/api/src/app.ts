import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "@wooble/db";
import apiPackage from "../package.json" with { type: "json" };
import migrationJournal from "../../../packages/db/drizzle/meta/_journal.json" with { type: "json" };
import { accessGuard, type Actor, type Api } from "./lib/auth";
import { liveRoutes } from "./lib/live";
import { isDatabaseConnectionError } from "./lib/http-error";
import { corsPlugin } from "./plugins/cors";
import { adminRoutes } from "./modules/auth/admin";
import { authRoutes } from "./modules/auth/routes";
import { invitationRoutes } from "./modules/workspace/invitations";
import { workspaceRoutes } from "./modules/workspace/routes";
import { canvasRoutes } from "./modules/canvas/routes";
import { entityRoutes } from "./modules/entity/routes";
import { connectionRoutes } from "./modules/connection/routes";

const requiredMigrationEntries = migrationJournal.entries.length;
const requiredMigrationTimestamp = Math.max(...migrationJournal.entries.map((entry) => entry.when));
const safeVersionPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type MigrationReadiness = {
  status: "current" | "pending";
  applied: number;
  required: number;
};

export function migrationReadiness(appliedValue: number | null, latestValue: number | null): MigrationReadiness {
  const applied = appliedValue !== null && Number.isSafeInteger(appliedValue) && appliedValue >= 0 ? appliedValue : 0;
  const latest = latestValue !== null && Number.isSafeInteger(latestValue) && latestValue >= 0 ? latestValue : 0;
  const current = applied >= requiredMigrationEntries && latest >= requiredMigrationTimestamp;
  return { status: current ? "current" : "pending", applied, required: requiredMigrationEntries };
}

function runningVersion(): string {
  const candidate = process.env.WOOBLE_VERSION ?? apiPackage.version;
  return safeVersionPattern.test(candidate) ? candidate : "unknown";
}

function registerErrorHandler(app: Api) {
  app.onError((context) => {
    const { code, error, set, request } = context;
    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        message: `Route ${request.method}:${new URL(request.url).pathname} not found`,
        error: "Not Found",
        statusCode: 404,
      };
    }
    if (code === "PARSE") {
      set.status = 400;
      return { message: "Body is not valid JSON but content-type is set to 'application/json'" };
    }
    const customStatus = (error as unknown as { status?: unknown }).status;
    let statusCode = typeof customStatus === "number" ? customStatus : 500;
    if (code === "VALIDATION" && statusCode === 500) statusCode = 400;
    if (statusCode < 500) return { message: error instanceof Error ? error.message : "Request failed" };
    console.error("Request failed", error);
    const unavailable = statusCode === 503 || isDatabaseConnectionError(error);
    set.status = unavailable ? 503 : 500;
    return {
      message: unavailable
        ? "The service is temporarily unavailable. Try again in a moment."
        : "Something went wrong. Please try again.",
    };
  });
}

export function createApp(options: { configure?: (app: Api) => void; liveRecheckMs?: number } = {}): Api {
  const app = new Elysia({ strictPath: true, serve: { reusePort: false } }).decorate("actor", null as Actor | null);
  registerErrorHandler(app);
  app.use(corsPlugin());
  app.use(accessGuard());
  liveRoutes(app, options.liveRecheckMs);
  app.get("/health", async (context) => {
    try {
      await db.execute(sql`select 1`);
    } catch {
      context.set.status = 503;
      return {
        status: "unavailable",
        database: "disconnected",
        version: runningVersion(),
        migrations: { status: "unknown", applied: 0, required: requiredMigrationEntries },
      };
    }

    try {
      const result = await db.execute(sql`
        select count(*)::int as applied, max(created_at)::bigint as latest
        from drizzle.__drizzle_migrations
      `);
      const row = result.rows[0];
      const migrations = migrationReadiness(
        row?.applied === null || row?.applied === undefined ? null : Number(row.applied),
        row?.latest === null || row?.latest === undefined ? null : Number(row.latest),
      );
      if (migrations.status !== "current") context.set.status = 503;
      return {
        status: migrations.status === "current" ? "ok" : "unavailable",
        database: "connected",
        version: runningVersion(),
        migrations,
      };
    } catch {
      context.set.status = 503;
      return {
        status: "unavailable",
        database: "connected",
        version: runningVersion(),
        migrations: migrationReadiness(null, null),
      };
    }
  });
  options.configure?.(app);
  authRoutes(app);
  adminRoutes(app);
  workspaceRoutes(app);
  invitationRoutes(app);
  canvasRoutes(app);
  entityRoutes(app);
  connectionRoutes(app);
  return app;
}
