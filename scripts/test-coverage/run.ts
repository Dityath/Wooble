/**
 * Full-source coverage for the API, web app, and shared runtime packages.
 *
 *   bun run coverage                 # all suites; API tests need DATABASE_URL for an isolated database
 *   bun run coverage --without-api   # skip the API suite when no test database is available
 *   bun run coverage --enforce       # fail when an area drops below its floor in areas.ts
 *
 * CI runs each suite in its own step and reports once at the end, so no test runs twice:
 *
 *   bun run coverage --suite web     # run one suite (web, shared, or api) and keep its raw coverage
 *   bun run coverage --merge-only    # report on the suites already run; add --enforce to check floors
 *
 * Writes coverage/lcov.info (merged, full-source) and coverage/summary.md.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { type CoverageArea, coverageAreas, coverageExclusions, coverageTarget } from "./areas";
import { type CoverageMap, formatLcov, mergeRuns, parseLcov, withInventory } from "./lcov";
import { areaSources } from "./sources";

const root = resolve(import.meta.dir, "../..");
const outputDir = join(root, "coverage");
const rawDir = join(outputDir, "raw");
const argv = process.argv.slice(2);
const args = new Set(argv);
const withoutApi = args.has("--without-api");
const enforce = args.has("--enforce");
const mergeOnly = args.has("--merge-only");
const suiteIndex = argv.indexOf("--suite");
const onlySuite = suiteIndex === -1 ? undefined : argv[suiteIndex + 1];
const suiteIds = ["web", "shared", "api"];

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

if (suiteIndex !== -1 && !suiteIds.includes(onlySuite ?? "")) fail(`--suite expects one of: ${suiteIds.join(", ")}.`);
if (onlySuite && mergeOnly) fail("Use either --suite or --merge-only, not both.");
if (onlySuite && (enforce || withoutApi)) fail("--enforce and --without-api apply to a report, not to --suite.");

const needsDatabase = onlySuite ? onlySuite === "api" : !mergeOnly && !withoutApi;
if (needsDatabase && !process.env.DATABASE_URL)
  fail(
    "API coverage needs DATABASE_URL pointing at an isolated, migrated test database.\n" +
      "Set it (see CONTRIBUTING.md) or rerun with --without-api.",
  );

async function packageTestDirs(): Promise<string[]> {
  const dirs = new Set<string>();
  for await (const file of new Glob("packages/*/tests/**/*.test.ts").scan({ cwd: root }))
    dirs.add(file.split("/").slice(0, 3).join("/"));
  return [...dirs].sort();
}

interface Suite {
  id: string;
  paths: string[];
  env?: Record<string, string>;
}

async function runSuite({ id, paths, env }: Suite): Promise<{ id: string; ok: boolean; coverage: CoverageMap }> {
  const dir = join(rawDir, id);
  const command = ["bun", "test", ...paths, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`];
  console.log(`\n$ ${command.join(" ")}`);
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const ok = (await child.exited) === 0;
  const lcovPath = join(dir, "lcov.info");
  const coverage = existsSync(lcovPath) ? parseLcov(await readFile(lcovPath, "utf8")) : new Map();
  return { id, ok, coverage };
}

const percent = (hit: number, found: number) => (found === 0 ? 100 : (hit / found) * 100);
const format = (value: number) => `${value.toFixed(2)}%`;

interface FileRow {
  file: string;
  loaded: boolean;
  lines: number;
  functions: number;
}

interface AreaResult {
  area: CoverageArea;
  measured: boolean;
  files: FileRow[];
  lines: number;
  functions: number;
  passes: boolean;
}

function summarize(area: CoverageArea, files: string[], coverage: CoverageMap, tested: CoverageMap): AreaResult {
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  const rows: FileRow[] = [];
  for (const file of files) {
    const entry = coverage.get(file);
    if (!entry) continue;
    const found = entry.lines.size;
    const hit = [...entry.lines.values()].filter((hits) => hits > 0).length;
    linesFound += found;
    linesHit += hit;
    functionsFound += entry.functionsFound;
    functionsHit += entry.functionsHit;
    rows.push({
      file,
      loaded: tested.has(file),
      lines: percent(hit, found),
      functions: percent(entry.functionsHit, entry.functionsFound),
    });
  }
  const measured = !(withoutApi && area.id === "api");
  const lines = percent(linesHit, linesFound);
  const functions = percent(functionsHit, functionsFound);
  const passes = lines >= area.thresholds.lines && functions >= area.thresholds.functions;
  return { area, measured, files: rows, lines, functions, passes };
}

function markdown(results: AreaResult[], suitesNote: string): string {
  const out: string[] = ["## Coverage", ""];
  out.push(
    `Full-source coverage: every eligible production file counts, and files no test loads count as 0%. ` +
      `Target: ${coverageTarget.lines}% lines and ${coverageTarget.functions}% functions per area.`,
    "",
    "| Area | Files (loaded by tests) | Lines | Functions | Floor (lines / functions) | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const result of results) {
    const loaded = result.files.filter((row) => row.loaded).length;
    const status = !result.measured ? "⏭️ Not measured" : result.passes ? "✅ At or above floor" : "❌ Below floor";
    out.push(
      `| ${result.area.label} | ${result.files.length} (${loaded}) | ${format(result.lines)} | ${format(result.functions)} | ` +
        `${result.area.thresholds.lines}% / ${result.area.thresholds.functions}% | ${status} |`,
    );
  }
  out.push("", suitesNote, "");
  for (const result of results) {
    const below = result.files
      .filter((row) => row.lines < coverageTarget.lines || row.functions < coverageTarget.functions)
      .sort((a, b) => a.lines - b.lines || a.functions - b.functions);
    out.push(`<details><summary>${result.area.label}: ${below.length} files below target</summary>`, "");
    if (below.length) {
      out.push("| File | Lines | Functions | Loaded by tests |", "| --- | --- | --- | --- |");
      for (const row of below)
        out.push(
          `| \`${row.file}\` | ${format(row.lines)} | ${format(row.functions)} | ${row.loaded ? "yes" : "no"} |`,
        );
    }
    out.push("", "</details>", "");
  }
  out.push("<details><summary>Excluded files</summary>", "");
  for (const exclusion of coverageExclusions) out.push(`- \`${exclusion.path}\`: ${exclusion.reason}`);
  out.push("", "</details>", "");
  return out.join("\n");
}

async function plannedSuites(): Promise<Suite[]> {
  // The web suite preloads a DOM; the API suite must not get one (see apps/web/tests/support/dom.ts).
  const suites: Suite[] = [{ id: "web", paths: ["--preload", "./apps/web/tests/support/dom.ts", "apps/web/tests"] }];
  const sharedDirs = await packageTestDirs();
  if (sharedDirs.length) suites.push({ id: "shared", paths: sharedDirs });
  if (!withoutApi) suites.push({ id: "api", paths: ["apps/api/tests"] });
  return suites;
}

async function readSuite(id: string): Promise<CoverageMap | undefined> {
  const lcovPath = join(rawDir, id, "lcov.info");
  return existsSync(lcovPath) ? parseLcov(await readFile(lcovPath, "utf8")) : undefined;
}

if (onlySuite) {
  const suite = (await plannedSuites()).find((candidate) => candidate.id === onlySuite);
  if (!suite) fail(`No tests found for the ${onlySuite} suite.`);
  await rm(join(rawDir, suite.id), { recursive: true, force: true });
  const run = await runSuite(suite);
  console.log(
    `\nRaw ${suite.id} coverage: coverage/raw/${suite.id}/lcov.info. Report with: bun run coverage --merge-only`,
  );
  process.exit(run.ok ? 0 : 1);
}

async function recordedRuns(suites: Suite[]) {
  const runs: Array<{ id: string; ok: boolean; coverage: CoverageMap }> = [];
  const missing: string[] = [];
  for (const suite of suites) {
    const coverage = await readSuite(suite.id);
    if (coverage) runs.push({ id: suite.id, ok: true, coverage });
    else missing.push(suite.id);
  }
  if (missing.length)
    fail(`No coverage recorded for: ${missing.join(", ")}. Run \`bun run coverage --suite <name>\` for each first.`, 1);
  return runs;
}

const suites = await plannedSuites();
// A merge reads the suites' raw coverage, so it must not clear coverage/raw.
const recorded = mergeOnly ? await recordedRuns(suites) : undefined;
if (mergeOnly) await rm(join(rawDir, "inventory"), { recursive: true, force: true });
else await rm(outputDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });

const inventoryRun = await runSuite({
  id: "inventory",
  paths: ["./scripts/test-coverage/inventory.probe.ts"],
});
if (!inventoryRun.ok) fail("The coverage inventory could not load every eligible source file.", 1);

const suiteRuns = recorded ?? [];
if (!recorded) for (const suite of suites) suiteRuns.push(await runSuite(suite));
const suitesNote = recorded
  ? `Suites merged from their own test steps: ${suites.map((suite) => suite.id).join(", ")}.`
  : `Suites: ${suiteRuns.map((run) => `${run.id} ${run.ok ? "passed" : "failed"}`).join(", ")}.`;

const tested = mergeRuns(suiteRuns.map((run) => run.coverage));
const results: AreaResult[] = [];
const merged: CoverageMap = new Map();
for (const area of coverageAreas) {
  const files = await areaSources(root, area);
  const coverage = withInventory(tested, inventoryRun.coverage, files);
  for (const [file, entry] of coverage) merged.set(file, entry);
  results.push(summarize(area, files, coverage, tested));
}

const summary = markdown(results, suitesNote);
await writeFile(join(outputDir, "lcov.info"), formatLcov(merged));
await writeFile(join(outputDir, "summary.md"), summary);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: set by GitHub Actions; this script runs directly, not as a Turborepo task.
const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) await writeFile(stepSummary, summary, { flag: "a" });

console.log("\nFull-source coverage");
for (const result of results) {
  const note = result.measured ? (result.passes ? "ok" : "BELOW FLOOR") : "not measured";
  console.log(
    `  ${result.area.label.padEnd(15)} lines ${format(result.lines).padStart(7)}  functions ${format(result.functions).padStart(7)}  ` +
      `floor ${result.area.thresholds.lines}/${result.area.thresholds.functions}  ${note}`,
  );
}
console.log(`\nDetails: coverage/summary.md, merged LCOV: coverage/lcov.info`);

const failedSuites = suiteRuns.filter((run) => !run.ok);
if (failedSuites.length) {
  console.error(`Test suites failed: ${failedSuites.map((run) => run.id).join(", ")}`);
  process.exit(1);
}
if (enforce) {
  const below = results.filter((result) => result.measured && !result.passes);
  if (below.length) {
    console.error(`Coverage below floor: ${below.map((result) => result.area.label).join(", ")}`);
    process.exit(1);
  }
}
