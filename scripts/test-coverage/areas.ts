/**
 * Coverage areas and their full-source denominators.
 *
 * Every first-party production file matched by `sources` is counted, whether or not a test imports it.
 * Exclusions must stay narrow and carry a reason; `docs/testing.md` explains the policy.
 */
export interface CoverageArea {
  id: "api" | "web" | "shared";
  label: string;
  sources: string[];
  /** Floors enforced by `--enforce`. Ratchet them upward as tests land; the goal is 90/90 per area. */
  thresholds: { lines: number; functions: number };
}

export interface CoverageExclusion {
  path: string;
  reason: string;
}

export const coverageTarget = { lines: 90, functions: 90 };

export const coverageAreas: CoverageArea[] = [
  {
    id: "api",
    label: "API",
    sources: ["apps/api/src/**/*.ts"],
    thresholds: { lines: 81, functions: 91 },
  },
  {
    id: "web",
    label: "Web",
    sources: ["apps/web/src/**/*.{ts,tsx}"],
    thresholds: { lines: 90, functions: 90 },
  },
  {
    id: "shared",
    label: "Shared runtime",
    sources: ["packages/*/src/**/*.ts"],
    thresholds: { lines: 90, functions: 90 },
  },
];

export const coverageExclusions: CoverageExclusion[] = [
  {
    path: "apps/api/src/index.ts",
    reason: "Process entry point: binds the HTTP port. Routes are exercised through `createApp` in app.ts.",
  },
  {
    path: "apps/web/src/main.tsx",
    reason: "Browser bootstrap: mounts React into #root and loads CSS. Covered by Playwright journeys.",
  },
  {
    path: "packages/ui/src/index.ts",
    reason: "Placeholder entry point that only exports the package name; UI primitives live in apps/web for now.",
  },
  {
    path: "packages/db/src/seed.ts",
    reason: "Developer-only demo data script run with `bun run db:seed`; not part of the deployed runtime.",
  },
];
