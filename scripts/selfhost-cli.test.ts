import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const temporaryRoots: string[] = [];
function fixture(
  options: {
    volumes?: string;
    inspect?: string | Record<string, string>;
    legacyProject?: string;
    project?: string;
    shellVersion?: string;
    fail?: string;
  } = {},
) {
  const base = mkdtempSync(join(tmpdir(), "wooble-cli-test-"));
  temporaryRoots.push(base);
  mkdirSync(join(base, "deploy"));
  copyFileSync(join(root, "deploy/wooble"), join(base, "deploy/wooble"));
  chmodSync(join(base, "deploy/wooble"), 0o755);
  for (const name of ["compose.selfhost.yml", "compose.selfhost.local.yml"])
    copyFileSync(join(root, name), join(base, name));
  writeFileSync(
    join(base, ".env"),
    `WOOBLE_VERSION=1.2.3\nWOOBLE_COMPOSE_PROJECT_NAME=${options.project ?? "wooble"}\n${options.legacyProject ? `WOOBLE_LEGACY_PROJECT_NAME=${options.legacyProject}\n` : ""}WOOBLE_MODE=local\nWOOBLE_DB_PASSWORD=fictional-secret\nWOOBLE_ORIGIN=https://localhost:18083\nWOOBLE_HTTP_PORT=18083\n`,
  );
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "date"), "#!/bin/sh\nprintf '%s\\n' '20260102T030405Z'\n");
  chmodSync(join(bin, "date"), 0o755);
  const log = join(base, "calls.log");
  const inspectCases =
    typeof options.inspect === "object"
      ? Object.entries(options.inspect)
          .map(([name, value]) => `  *'${name}'*) printf '%s\\n' '${value}' ;;`)
          .join("\n")
      : `  *) printf '%s\\n' '${options.inspect ?? "postgres-data|"}' ;;`;
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
printf 'WOOBLE_VERSION=%s\\n' "\${WOOBLE_VERSION:-unset}" >> '${log}'
case "$*" in
  *'volume ls'*) printf '%s\\n' '${options.volumes ?? ""}' ;;
  *'volume inspect'*)
  case "$*" in
${inspectCases}
  esac ;;
  *'pg_dump'*) ${options.fail === "backup" ? "exit 19" : "printf 'fictional-dump\\n'"} ;;
  *'pg_restore'*) ${options.fail === "restore" ? `if [ ! -e '${base}/restore-failed-once' ]; then touch '${base}/restore-failed-once'; exit 20; fi; cat >/dev/null` : "cat >/dev/null"} ;;
  *'migrate'*) ${options.fail === "migration" ? "exit 21" : "exit 0"} ;;
  *'up -d'*) ${options.fail === "start" ? "exit 22" : "exit 0"} ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const backupFile = join(base, "input.dump");
  writeFileSync(backupFile, "fictional input data\n");
  function run(...args: string[]) {
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WOOBLE_ENV_FILE: join(base, ".env") };
    delete environment.WOOBLE_VERSION;
    if (options.shellVersion) environment.WOOBLE_VERSION = options.shellVersion;
    return spawnSync(join(base, "deploy/wooble"), args, {
      encoding: "utf8",
      env: environment,
    });
  }
  return { base, log, backupFile, run };
}
afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("self-host CLI safety", () => {
  it("requires a version and explicit restore confirmation before Docker calls", () => {
    const f = fixture();
    writeFileSync(join(f.base, ".env"), "WOOBLE_MODE=local\nWOOBLE_COMPOSE_PROJECT_NAME=test-project\n");
    expect(f.run("up").stderr).toContain("WOOBLE_VERSION is required");
    expect(f.run("restore", f.backupFile).stderr).toContain("explicit confirmation required");
    expect(existsSync(f.log)).toBe(false);
  });

  it("rejects duplicate version or mode settings before Docker calls", () => {
    for (const duplicate of [
      "WOOBLE_VERSION=1.2.3\nWOOBLE_VERSION=2.0.0\n",
      "WOOBLE_MODE=local\nWOOBLE_MODE=domain\n",
    ]) {
      const f = fixture();
      writeFileSync(
        join(f.base, ".env"),
        `${duplicate}WOOBLE_COMPOSE_PROJECT_NAME=wooble\nWOOBLE_DB_PASSWORD=fictional-secret\nWOOBLE_ORIGIN=https://localhost:18083\nWOOBLE_HTTP_PORT=18083\n`,
      );
      const result = f.run("up");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("duplicate self-host settings");
      expect(existsSync(f.log)).toBe(false);
    }
  });

  it("ignores an unrelated project's postgres-data volume", () => {
    const f = fixture({ volumes: "other-app_postgres-data", inspect: "postgres-data|other-app" });
    expect(f.run("status").status).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("--project-name wooble");
    expect(readFileSync(f.log, "utf8")).not.toContain("volume rm");
  });

  it("reuses the exact Wooble v0.1.0 project identity", () => {
    const f = fixture({ volumes: "wooble_postgres-data", inspect: "postgres-data|wooble" });
    expect(f.run("status").status).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("--project-name wooble");
  });

  it("refuses ambiguity among Wooble and explicitly selected legacy volumes", () => {
    const f = fixture({
      volumes: "wooble_postgres-data\nlegacy-db_postgres-data",
      inspect: {
        "wooble_postgres-data": "postgres-data|wooble",
        "legacy-db_postgres-data": "postgres-data|legacy-db",
      },
      legacyProject: "legacy-db",
    });
    const result = f.run("up");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("multiple matching Wooble postgres-data volumes");
    expect(readFileSync(f.log, "utf8")).not.toContain(" up ");
  });

  it("reuses a custom legacy project only when the operator names it explicitly", () => {
    const f = fixture({
      volumes: "wooble_archive_postgres-data",
      inspect: "postgres-data|wooble_archive",
      legacyProject: "wooble_archive",
    });
    expect(f.run("status").status).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("--project-name wooble_archive");
  });

  it("refuses a malformed volume belonging to the known Wooble project", () => {
    const f = fixture({ volumes: "wooble_postgres-data", inspect: "wrong-key|wooble" });
    const result = f.run("up");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid matching Wooble postgres-data volume labels");
    expect(readFileSync(f.log, "utf8")).not.toContain(" up ");
  });

  it("creates private UTC backups under backups and keeps permissions restrictive", () => {
    const f = fixture();
    const result = f.run("backup");
    expect(result.status).toBe(0);
    const path = result.stdout.trim();
    expect(path).toMatch(/\/backups\/wooble-\d{8}T\d{6}Z\.dump$/);
    expect(readFileSync(path, "utf8")).toContain("fictional-dump");
    const mode = Number.parseInt(statSync(path).mode.toString(8).slice(-3), 8);
    expect(mode & 0o077).toBe(0);
  });

  it("does not delete a pre-existing backup when the UTC timestamp collides", () => {
    const f = fixture();
    const first = f.run("backup");
    expect(first.status).toBe(0);
    const path = first.stdout.trim();
    const original = readFileSync(path, "utf8");
    const second = f.run("backup");
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("backup already exists");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("does not restore when the automatic pre-restore backup fails", () => {
    const f = fixture({ fail: "backup" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("automatic pre-restore backup failed");
    expect(readFileSync(f.log, "utf8")).not.toContain("pg_restore");
  });

  it("attempts data recovery and restart after a failed restore while retaining backup", () => {
    const f = fixture({ fail: "restore" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("original data recovered");
    expect(readFileSync(f.log, "utf8")).toContain("up -d");
    expect(result.stderr).toContain("backup retained");
  });

  it("backs up before update and runs migrations before starting the target release", () => {
    const f = fixture({ shellVersion: "1.2.3" });
    const result = f.run("update", "2.0.0");
    expect(result.status).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    expect(calls.indexOf("pg_dump")).toBeLessThan(calls.indexOf("pull api web migrate"));
    expect(calls.indexOf("migrate")).toBeLessThan(calls.indexOf("up -d"));
    expect(calls).toContain("WOOBLE_VERSION=2.0.0");
    expect(readFileSync(join(f.base, ".env"), "utf8")).toContain("WOOBLE_VERSION=1.2.3");
  });

  it("keeps the automatic restore backup when restarting after a successful restore fails", () => {
    const f = fixture({ fail: "start" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restore completed but stack restart failed");
    const retained = result.stderr.match(/pre-restore backup retained at (.+)$/m)?.[1];
    expect(retained && existsSync(retained)).toBe(true);
  });

  it("does not pull or migrate when the pre-update backup fails", () => {
    const f = fixture({ fail: "backup" });
    const result = f.run("update", "2.0.0");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("update backup failed; update was not attempted");
    const calls = readFileSync(f.log, "utf8");
    expect(calls).not.toContain("pull api web migrate");
    expect(calls).not.toContain("migrate");
  });

  it("retains recovery instructions and backup after migration or start failure", () => {
    const migration = fixture({ fail: "migration" }).run("update", "2.0.0");
    expect(migration.status).not.toBe(0);
    expect(migration.stderr).toContain("backup retained");
    const start = fixture({ fail: "start" }).run("update", "2.0.0");
    expect(start.status).not.toBe(0);
    expect(start.stderr).toContain("restore it with deploy/wooble restore --confirm");
  });
});
