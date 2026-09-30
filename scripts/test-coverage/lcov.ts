/** Minimal LCOV handling for the records Bun writes: SF, FNF, FNH, DA, LF, LH. */
export interface FileCoverage {
  /** Executable line number -> hit count. */
  lines: Map<number, number>;
  functionsFound: number;
  functionsHit: number;
}

export type CoverageMap = Map<string, FileCoverage>;

export function parseLcov(text: string): CoverageMap {
  const files: CoverageMap = new Map();
  let current: FileCoverage | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = { lines: new Map(), functionsFound: 0, functionsHit: 0 };
      files.set(line.slice(3), current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",").map(Number);
      current.lines.set(lineNumber, (current.lines.get(lineNumber) ?? 0) + hits);
    } else if (line.startsWith("FNF:")) {
      current.functionsFound = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      current.functionsHit = Number(line.slice(4));
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return files;
}

/**
 * Merges behavioral test runs of the same file.
 *
 * Lines: hits add up. JSC reports finer blocks for functions a run executed, so a run that skipped a
 * function can list lines (such as its closing brace) that another run does not treat as executable.
 * A line therefore counts when some run hit it or every run that loaded the file lists it.
 *
 * Functions: Bun reports totals without names, so the merged hit count is the best single run, a
 * lower bound on the true union.
 */
export function mergeRuns(runs: CoverageMap[]): CoverageMap {
  const merged: CoverageMap = new Map();
  const files = new Set(runs.flatMap((run) => [...run.keys()]));
  for (const file of files) {
    const loads = runs.map((run) => run.get(file)).filter((entry): entry is FileCoverage => entry !== undefined);
    const lineNumbers = new Set(loads.flatMap((entry) => [...entry.lines.keys()]));
    const lines = new Map<number, number>();
    for (const lineNumber of lineNumbers) {
      const hits = loads.reduce((total, entry) => total + (entry.lines.get(lineNumber) ?? 0), 0);
      if (hits > 0 || loads.every((entry) => entry.lines.has(lineNumber))) lines.set(lineNumber, hits);
    }
    const functionsFound = Math.max(...loads.map((entry) => entry.functionsFound));
    const functionsHit = Math.min(functionsFound, Math.max(...loads.map((entry) => entry.functionsHit)));
    merged.set(file, { lines, functionsFound, functionsHit });
  }
  return merged;
}

/**
 * Completes the denominator. Files a behavioral test loaded keep Bun's own line set. Files no test
 * loaded take their executable lines and functions from the inventory with zero hits. (JSC splits
 * executed functions into finer blocks than unexecuted ones, so the two line sets are not unioned.)
 */
export function withInventory(tested: CoverageMap, inventory: CoverageMap, files: string[]): CoverageMap {
  const result: CoverageMap = new Map();
  for (const file of files) {
    const covered = tested.get(file);
    if (covered) {
      result.set(file, covered);
      continue;
    }
    const known = inventory.get(file);
    const lines = new Map<number, number>();
    for (const lineNumber of known?.lines.keys() ?? []) lines.set(lineNumber, 0);
    result.set(file, { lines, functionsFound: known?.functionsFound ?? 0, functionsHit: 0 });
  }
  return result;
}

export function formatLcov(coverage: CoverageMap): string {
  const records: string[] = [];
  for (const [file, { lines, functionsFound, functionsHit }] of coverage) {
    const entries = [...lines].sort(([a], [b]) => a - b);
    records.push(
      [
        "TN:",
        `SF:${file}`,
        `FNF:${functionsFound}`,
        `FNH:${functionsHit}`,
        ...entries.map(([lineNumber, hits]) => `DA:${lineNumber},${hits}`),
        `LF:${entries.length}`,
        `LH:${entries.filter(([, hits]) => hits > 0).length}`,
        "end_of_record",
      ].join("\n"),
    );
  }
  return `${records.join("\n")}\n`;
}
