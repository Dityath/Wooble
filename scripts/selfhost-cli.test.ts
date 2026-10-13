import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
    shellOrigin?: string;
    mode?: string;
    origin?: string;
    httpPort?: string;
    caddyHost?: string;
    bindAddress?: string;
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
  copyFileSync(join(root, "deploy/Caddyfile"), join(base, "deploy/Caddyfile"));
  writeFileSync(
    join(base, ".env"),
    `WOOBLE_VERSION=1.2.3\nWOOBLE_COMPOSE_PROJECT_NAME=${options.project ?? "wooble"}\n${options.legacyProject ? `WOOBLE_LEGACY_PROJECT_NAME=${options.legacyProject}\n` : ""}WOOBLE_MODE=${options.mode ?? "local"}\nWOOBLE_DB_PASSWORD=fictional-secret\nWOOBLE_ORIGIN=${options.origin ?? "https://localhost:18083"}\nWOOBLE_HTTP_PORT=${options.httpPort ?? "18083"}\nWOOBLE_CADDY_HOST=${options.caddyHost ?? "192.0.2.10"}\nWOOBLE_BIND_ADDRESS=${options.bindAddress ?? "192.0.2.10"}\nWOOBLE_DOMAIN=wooble.example.test\n`,
  );
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "date"), "#!/bin/sh\nprintf '%s\\n' '20260102T030405Z'\n");
  chmodSync(join(bin, "date"), 0o755);
  const log = join(base, "calls.log");
  const databaseState = join(base, "database-state.dump");
  writeFileSync(databaseState, "fictional-live-before-restore\n");
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
  *'config -q'*) ${options.fail === "config-secret" ? "printf '%s\\n' 'invalid value fictional-bind-secret' >&2; exit 23" : "exit 0"} ;;
  *'volume ls'*) printf '%s\\n' '${options.volumes ?? ""}' ;;
  *'volume inspect'*)
  case "$*" in
${inspectCases}
  esac ;;
  *'pg_dump'*) ${options.fail === "backup" ? "exit 19" : `cat '${databaseState}'`} ;;
  *'pg_restore'*) ${options.fail === "restore" ? `cat > '${databaseState}'; if [ ! -e '${base}/restore-failed-once' ]; then touch '${base}/restore-failed-once'; exit 20; fi` : `cat > '${databaseState}'`} ;;
  *'run --rm migrate'*) ${options.fail === "migration" ? "exit 21" : options.fail === "migration-once" ? `if [ ! -e '${base}/migration-failed-once' ]; then touch '${base}/migration-failed-once'; exit 21; fi; exit 0` : "exit 0"} ;;
  *'pull api web migrate'*) exit 0 ;;
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
    if (options.shellOrigin) environment.WOOBLE_ORIGIN = options.shellOrigin;
    return spawnSync(join(base, "deploy/wooble"), args, {
      encoding: "utf8",
      env: environment,
    });
  }
  return { base, log, backupFile, databaseState, run };
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

  it("diagnoses a safe local origin and health without printing the database password", () => {
    const f = fixture();
    const result = f.run("diagnose");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode=local project=wooble version=1.2.3");
    expect(result.stdout).not.toContain("fictional-secret");
    expect(result.stderr).not.toContain("fictional-secret");
  });

  it("rejects malformed local HTTPS origins without echoing query secrets", () => {
    const f = fixture();
    const envPath = join(f.base, ".env");
    const env = readFileSync(envPath, "utf8");
    writeFileSync(
      envPath,
      env.replace("https://localhost:18083", "https://localhost:18083/path?token=fictional-secret"),
    );
    const result = f.run("diagnose");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local mode requires an HTTPS localhost origin");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-secret");
  });

  it("suppresses raw Compose config errors that may contain secret values", () => {
    const f = fixture({
      mode: "private",
      origin: "https://192.0.2.10:18083",
      fail: "config-secret",
      bindAddress: "fictional-bind-secret",
    });
    const result = f.run("diagnose");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("check WOOBLE_VERSION, WOOBLE_ORIGIN, WOOBLE_BIND_ADDRESS");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-bind-secret");
  });

  it("rejects invalid or mismatched HTTPS ports without printing the origin", () => {
    for (const origin of [
      "https://localhost:abc",
      "https://localhost:65536",
      "https://localhost:18443",
      "https://localhost:18083?token=fictional-secret",
      "https://user:password@localhost:18083",
    ]) {
      const f = fixture({ origin });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("local mode requires an HTTPS localhost origin");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-secret");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("password");
    }
  });

  it("accepts an HTTPS origin without an explicit port only for port 443", () => {
    const f = fixture({ origin: "https://localhost", httpPort: "443" });
    expect(f.run("diagnose").status).toBe(0);
    const wrongPort = fixture({ origin: "https://localhost", httpPort: "18083" });
    expect(wrongPort.run("diagnose").status).not.toBe(0);
  });

  it("validates the effective shell origin without echoing its secret query", () => {
    const f = fixture({ shellOrigin: "https://localhost:18083/?token=fictional-secret" });
    const result = f.run("diagnose");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local mode requires an HTTPS localhost origin");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-secret");
  });

  it("requires private mode HTTPS origin to match the configured host and published port", () => {
    const valid = fixture({ mode: "private", origin: "https://192.0.2.10:18083" });
    expect(valid.run("diagnose").status).toBe(0);
    const mismatch = fixture({ mode: "private", origin: "https://other.example.test:18083" });
    const result = mismatch.run("diagnose");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly match WOOBLE_CADDY_HOST");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-secret");
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
      project: "wooble_archive",
    });
    expect(f.run("status").status).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("--project-name wooble_archive");
  });

  const isolatedProjectFixture = () =>
    fixture({
      project: "isolated-install",
      volumes: "wooble_postgres-data",
      inspect: "postgres-data|wooble",
    });
  const expectIsolatedProject = (f: ReturnType<typeof fixture>) => {
    const calls = readFileSync(f.log, "utf8");
    expect(calls).toContain("--project-name isolated-install");
    expect(calls).not.toContain("--project-name wooble");
  };

  it("preserves an explicit project for up despite a Wooble volume", () => {
    const f = isolatedProjectFixture();
    expect(f.run("up").status).toBe(0);
    expectIsolatedProject(f);
  });

  it("preserves an explicit project for backup despite a Wooble volume", () => {
    const f = isolatedProjectFixture();
    expect(f.run("backup").status).toBe(0);
    expectIsolatedProject(f);
  });

  it("preserves an explicit project for restore despite a Wooble volume", () => {
    const f = isolatedProjectFixture();
    expect(f.run("restore", "--confirm", f.backupFile).status).toBe(0);
    expectIsolatedProject(f);
  });

  it("preserves an explicit project for update despite a Wooble volume", () => {
    const f = isolatedProjectFixture();
    expect(f.run("update", "2.0.0").status).toBe(0);
    expectIsolatedProject(f);
  });

  it("refuses to use a named legacy project's volume until the configured project matches it", () => {
    const f = fixture({
      project: "isolated-install",
      legacyProject: "old-wooble",
      volumes: "old-wooble_postgres-data",
      inspect: "postgres-data|old-wooble",
    });
    const result = f.run("up");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("set WOOBLE_COMPOSE_PROJECT_NAME=old-wooble explicitly");
    expect(readFileSync(f.log, "utf8")).not.toContain(" up -d");
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
    expect(path).toMatch(/\/backups\/wooble-\d{8}T\d{6}Z-\d+-\d+\.dump$/);
    expect(readFileSync(path, "utf8")).toContain("fictional-live-before-restore");
    const mode = Number.parseInt(statSync(path).mode.toString(8).slice(-3), 8);
    expect(mode & 0o077).toBe(0);
  });

  it("creates distinct private backups for quick consecutive dumps", () => {
    const f = fixture();
    const first = f.run("backup");
    expect(first.status).toBe(0);
    const second = f.run("backup");
    expect(second.status).toBe(0);
    const paths = [first.stdout.trim(), second.stdout.trim()];
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) {
      expect(readFileSync(path, "utf8")).toContain("fictional-live-before-restore");
      const mode = Number.parseInt(statSync(path).mode.toString(8).slice(-3), 8);
      expect(mode & 0o077).toBe(0);
    }
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
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
    const prebackup = result.stderr.match(/backup retained at (.+)$/m)?.[1];
    expect(prebackup && existsSync(prebackup)).toBe(true);
    if (prebackup) expect(readFileSync(prebackup, "utf8")).toBe("fictional-live-before-restore\n");
    expect(readFileSync(f.backupFile, "utf8")).toBe("fictional input data\n");
  });

  it("runs migrations after restore and before restarting the stack", () => {
    const f = fixture();
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("restore succeeded; migrations applied");
    const calls = readFileSync(f.log, "utf8");
    expect(calls.indexOf("pg_restore")).toBeLessThan(calls.indexOf("run --rm migrate"));
    expect(calls.indexOf("run --rm migrate")).toBeLessThan(calls.indexOf("up -d"));
  });

  it("recovers original data if migration of a restored backup fails", () => {
    const f = fixture({ fail: "migration-once" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restore migrations failed; original data recovered and stack restarted");
    const calls = readFileSync(f.log, "utf8");
    expect((calls.match(/pg_restore/g) ?? []).length).toBe(2);
    expect((calls.match(/migrate/g) ?? []).length).toBe(2);
    expect(calls).toContain("up -d");
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
  });

  it("backs up before update and runs migrations before starting the target release", () => {
    const f = fixture({ shellVersion: "1.2.3" });
    const result = f.run("update", "2.0.0");
    expect(result.status).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    const backupIndex = calls.indexOf("pg_dump");
    const pullIndex = calls.indexOf("pull api web migrate");
    const migrationIndex = calls.indexOf("run --rm migrate");
    const startIndex = calls.indexOf("up -d");
    expect(backupIndex).toBeLessThan(pullIndex);
    expect(pullIndex).toBeLessThan(migrationIndex);
    expect(migrationIndex).toBeLessThan(startIndex);
    expect(calls).toContain("WOOBLE_VERSION=2.0.0");
    expect(readFileSync(join(f.base, ".env"), "utf8")).toContain("WOOBLE_VERSION=2.0.0");
    expect((readdirSync(join(f.base, "backups")) as string[]).length).toBe(1);
    expect(f.run("up").status).toBe(0);
    expect(readFileSync(f.log, "utf8")).toContain("WOOBLE_VERSION=2.0.0");
  });

  it("keeps the automatic restore backup when restarting after a successful restore fails", () => {
    const f = fixture({ fail: "start" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restore start and automatic recovery failed");
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
    const migrationFixture = fixture({ fail: "migration" });
    const migration = migrationFixture.run("update", "2.0.0");
    expect(migration.status).not.toBe(0);
    expect(migration.stderr).toContain("migration failed; original version retained");
    expect(readFileSync(join(migrationFixture.base, ".env"), "utf8")).toContain("WOOBLE_VERSION=1.2.3");
    const migrationCalls = readFileSync(migrationFixture.log, "utf8");
    expect(migrationCalls).toContain("pull api web migrate");
    expect(migrationCalls).toContain("run --rm migrate");
    expect((readdirSync(join(migrationFixture.base, "backups")) as string[]).length).toBe(1);

    const startFixture = fixture({ fail: "start" });
    const start = startFixture.run("update", "2.0.0");
    expect(start.status).not.toBe(0);
    expect(start.stderr).toContain("original version retained");
    expect(readFileSync(join(startFixture.base, ".env"), "utf8")).toContain("WOOBLE_VERSION=1.2.3");
    expect((readdirSync(join(startFixture.base, "backups")) as string[]).length).toBe(1);
  });
});
