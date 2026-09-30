import { Glob } from "bun";
import { type CoverageArea, coverageAreas, coverageExclusions } from "./areas";

const excluded = new Set(coverageExclusions.map((exclusion) => exclusion.path));

export async function areaSources(root: string, area: CoverageArea): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of area.sources) {
    for await (const file of new Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      if (!excluded.has(file) && !file.endsWith(".d.ts")) files.add(file);
    }
  }
  return [...files].sort();
}

export async function eligibleSources(root: string): Promise<string[]> {
  const perArea = await Promise.all(coverageAreas.map((area) => areaSources(root, area)));
  return perArea.flat().sort();
}
