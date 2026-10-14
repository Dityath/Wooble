import { realpathSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

const missingLicenseText = "License text not distributed with package.";

export function generateThirdPartyNotices(root: string, output: string): number {
  const packages = new Map<string, { name: string; version: string; license: string; text: string }>();
  const visited = new Set<string>();

  function visit(directory: string) {
    let canonical: string;
    try {
      canonical = realpathSync(directory);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const path = join(directory, entry.name);
      if (entry.name === ".bun" && entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }

      try {
        const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
          license?: string;
          licenses?: Array<{ type?: string }>;
        };
        if (pkg.name && pkg.version) {
          const license =
            pkg.license ??
            pkg.licenses
              ?.map((item) => item.type)
              .filter(Boolean)
              .join(" OR ") ??
            "Unspecified";
          const licenseFiles = readdirSync(path, { withFileTypes: true })
            .filter((candidate) => candidate.isFile())
            .map((candidate) => candidate.name)
            .filter((name) => /^(license|licence|copying|notice)(?:[-_.]|$)/i.test(name))
            .sort((a, b) => a.localeCompare(b));
          const text = licenseFiles.length
            ? licenseFiles
                .map((filename) => `${filename}\n${readFileSync(join(path, filename), "utf8").trim()}`)
                .join("\n\n")
            : missingLicenseText;
          packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, text });
        }
      } catch {
        // Non-package folders inside node_modules are not dependency notices.
      }
      visit(join(path, "node_modules"));
    }
  }

  visit(join(root, "node_modules"));
  const sorted = [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  if (sorted.length === 0)
    throw new Error("No installed third-party packages found; refusing to produce an empty notices file.");

  const lines = [
    "Wooble third-party notices",
    "Generated from installed package manifests and bundled license files during the image build.",
    "",
    ...sorted.flatMap((pkg) => [`${pkg.name}@${pkg.version} — ${pkg.license}`, pkg.text, ""]),
  ];
  writeFileSync(output, `${lines.join("\n")}\n`, { mode: 0o644 });
  return sorted.length;
}

if (import.meta.main) {
  const output = process.argv[2] ?? join(process.cwd(), "THIRD_PARTY_NOTICES.txt");
  const count = generateThirdPartyNotices(process.cwd(), output);
  console.log(`Wrote notices for ${count} packages to ${output}`);
}
