/**
 * Loads every eligible source file once so Bun records its executable lines and functions.
 *
 * The merge step keeps only the denominators from this run and discards its hits: a file that no
 * behavioral test loads is reported at 0%. Importing here never raises a coverage percentage.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { eligibleSources } from "./sources";

const root = resolve(import.meta.dir, "../..");

test("every eligible source file can be loaded for the coverage inventory", async () => {
  const failures: string[] = [];
  for (const file of await eligibleSources(root)) {
    try {
      await import(resolve(root, file));
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  expect(failures).toEqual([]);
});
