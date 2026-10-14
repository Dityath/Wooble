import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { generateThirdPartyNotices } from "./third-party-notices";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function packageFixture(root: string, name: string, packageJson: object, files: Record<string, string> = {}) {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
  for (const [filename, contents] of Object.entries(files)) writeFileSync(join(directory, filename), contents);
}

describe("third-party notices", () => {
  test("includes actual text from LICENSE-MIT.txt and labels absent package text explicitly", () => {
    const root = mkdtempSync(join(tmpdir(), "wooble-notices-test-"));
    temporaryDirectories.push(root);
    const output = join(root, "THIRD_PARTY_NOTICES.txt");
    packageFixture(
      root,
      "licensed-dep",
      { name: "licensed-dep", version: "1.2.3", license: "MIT" },
      {
        LICENSE: "Synthetic base license text included by the test.",
        "LICENSE-MIT.txt": "Synthetic MIT notice text included by the test.",
        NOTICE: "Synthetic NOTICE text included by the test.",
      },
    );
    packageFixture(root, "metadata-only-dep", {
      name: "metadata-only-dep",
      version: "4.5.6",
      license: "Apache-2.0",
    });

    expect(generateThirdPartyNotices(root, output)).toBe(2);
    const notices = readFileSync(output, "utf8");
    expect(notices).toContain("Synthetic base license text included by the test.");
    expect(notices).toContain("Synthetic MIT notice text included by the test.");
    expect(notices).toContain("Synthetic NOTICE text included by the test.");
    expect(notices).toContain("metadata-only-dep@4.5.6 — Apache-2.0");
    expect(notices).toContain("License text not distributed with package.");
  });
});
