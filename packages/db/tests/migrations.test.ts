import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(import.meta.dir, "../drizzle");
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

// Migrations shipped in a release must never change: installations have already applied them. Add each release's
// new migrations here when it is tagged.
const released: Record<string, string> = {
  "0000_initial": "8266b97e23865e32dc773fc692b9db1ab3ff1e49e9540dcea8bf55f4760f7832",
  "0001_connection_bends": "8b8c8c896643912a730ef8f76c3fd52a6a52cd08b2f6fae240e730ee630e3daf",
  "0002_access": "a552f5ead9cbf9210649d4f0c6d7f9c400a1e7142a0ab113c0ed689d635c7701",
  "0003_canvas_share_mode": "be5d47a3143d2ed844751e6eece868af35c08442a7268412a75031f45a7b5652",
  "0004_kind_chimera": "d3310bbec1e88c407bf034921787cbd2b03e828436b2bf3da093689aa90c5a16",
  "0005_tranquil_prima": "c4bfdda33a2a5fa154cd675407a36c9095b1b97acb553bd7350d12390bd1faf6",
};

describe("migration journal", () => {
  it("numbers entries contiguously, with tags that match their index", () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(entry.tag).toMatch(new RegExp(`^${String(index).padStart(4, "0")}_[a-z0-9_]+$`));
    });
  });

  it("orders entries by strictly increasing timestamps, which drizzle relies on to apply them", () => {
    for (let index = 1; index < journal.entries.length; index++)
      expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when);
  });

  it("has exactly one SQL file for each entry", () => {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
    expect(files.sort()).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`).sort());
  });

  it("leaves released migrations unchanged", () => {
    for (const [tag, hash] of Object.entries(released)) {
      const content = readFileSync(join(migrationsDir, `${tag}.sql`));
      expect({ tag, hash: createHash("sha256").update(content).digest("hex") }).toEqual({ tag, hash });
    }
  });
});
