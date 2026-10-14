import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

describe("API image build context exclusions", () => {
  it("excludes backups, dump files, and test artifacts", () => {
    expect(dockerignore).toContain("backups");
    expect(dockerignore).toContain("**/*.dump");
    expect(dockerignore).toContain("**/*.dump.*");
    expect(dockerignore).toContain("**/test-results");
    expect(dockerignore).toContain("**/playwright-report");
  });

  it("does not exclude SQL migrations and keeps migration files in source", () => {
    expect(dockerignore.filter((pattern) => pattern.endsWith(".sql"))).toEqual([]);
    expect(readdirSync(join(root, "packages/db/drizzle")).some((name) => name.endsWith(".sql"))).toBe(true);
  });
});
