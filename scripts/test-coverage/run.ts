/**
 * Full-source coverage for the API, web app, and shared runtime packages.
 *
 *   bun run coverage                 # all suites; API tests need DATABASE_URL for an isolated database
 *   bun run coverage --without-api   # skip the API suite when no test database is available
 *   bun run coverage --enforce       # fail when an area drops below its floor in areas.ts
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
const args = new Set(process.argv.slice(2));
const withoutApi = args.has("--without-api");
const enforce = args.has("--enforce");

if (!withoutApi && !process.env.DATABASE_URL) {
  console.error(
    "API coverage needs DATABASE_URL pointing at an isolated, migrated test database.\n" +
      "Set it (see CONTRIBUTING.md) or rerun with --without-api.",
  );
  process.exit(2);
}

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

function markdown(results: AreaResult[], suites: Array<{ id: string; ok: boolean }>): string {
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
  out.push("", `Suites: ${suites.map((suite) => `${suite.id} ${suite.ok ? "passed" : "failed"}`).join(", ")}.`, "");
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

await rm(outputDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });

const inventoryRun = await runSuite({
  id: "inventory",
  paths: ["./scripts/test-coverage/inventory.probe.ts"],
});
if (!inventoryRun.ok) {
  console.error("The coverage inventory could not load every eligible source file.");
  process.exit(1);
}

// The web suite preloads a DOM; the API suite must not get one (see apps/web/tests/support/dom.ts).
const suites: Suite[] = [{ id: "web", paths: ["--preload", "./apps/web/tests/support/dom.ts", "apps/web/tests"] }];
const sharedDirs = await packageTestDirs();
if (sharedDirs.length) suites.push({ id: "shared", paths: sharedDirs });
if (!withoutApi) suites.push({ id: "api", paths: ["apps/api/tests"] });

const suiteRuns = [];
for (const suite of suites) suiteRuns.push(await runSuite(suite));

const tested = mergeRuns(suiteRuns.map((run) => run.coverage));
const results: AreaResult[] = [];
const merged: CoverageMap = new Map();
for (const area of coverageAreas) {
  const files = await areaSources(root, area);
  const coverage = withInventory(tested, inventoryRun.coverage, files);
  for (const [file, entry] of coverage) merged.set(file, entry);
  results.push(summarize(area, files, coverage, tested));
}

const summary = markdown(results, suiteRuns);
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
