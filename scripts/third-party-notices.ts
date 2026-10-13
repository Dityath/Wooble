import { realpathSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const output = process.argv[2] ?? join(root, "THIRD_PARTY_NOTICES.txt");
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
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.name.startsWith("@")) visit(path);
      else {
        const manifest = join(path, "package.json");
        try {
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
            name?: string;
            version?: string;
            license?: string;
            licenses?: Array<{ type?: string }>;
          };
          if (!pkg.name || !pkg.version) continue;
          const license =
            pkg.license ??
            pkg.licenses
              ?.map((item) => item.type)
              .filter(Boolean)
              .join(" OR ") ??
            "Unspecified";
          const licenseFile = readdirSync(path).find((name) => /^(license|licence|copying)(\.|$)/i.test(name));
          const text = licenseFile
            ? readFileSync(join(path, licenseFile), "utf8").trim()
            : "License text not distributed with package.";
          packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, text });
        } catch {
          // Non-package folders inside node_modules are not dependency notices.
        }
        visit(join(path, "node_modules"));
      }
    }
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
console.log(`Wrote notices for ${sorted.length} packages to ${output}`);
