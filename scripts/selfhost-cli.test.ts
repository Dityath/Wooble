import { afterEach, beforeAll, describe, expect, it } from "bun:test";
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

/** Command lines the Docker shim logged, in order (version lines are dropped). */
function commands(log: string) {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("WOOBLE_VERSION="));
}
/** Index of the first command containing `text` at or after `from`; fails the test when absent. */
function at(lines: string[], text: string, from = 0) {
  const index = lines.findIndex((line, i) => i >= from && line.includes(text));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

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
  *'stop web api'*) ${options.fail === "stop" ? "exit 24" : options.fail === "signal-stop" ? "kill -TERM $PPID; exit 0" : "exit 0"} ;;
  *'exec -T web cat '*) ${options.fail === "ca" ? "exit 25" : "printf '%s\\n' '-----BEGIN CERTIFICATE-----fictional'"} ;;
  *'PROBE_KIND=https'*) cat > /dev/null; ${options.fail === "probe-https" || options.fail === "probe-both" ? "exit 26" : options.fail === "probe-https-2" ? "exit 2" : "exit 0"} ;;
  *'PROBE_KIND=ws'*) cat > /dev/null; ${options.fail === "probe-ws" || options.fail === "probe-both" ? "exit 27" : "exit 0"} ;;
  *'127.0.0.1:3001/health'*) ${options.fail === "api-health" ? "exit 28" : "exit 0"} ;;
  *'config -q'*) ${options.fail === "config-secret" ? "printf '%s\\n' 'invalid value fictional-bind-secret' >&2; exit 23" : "exit 0"} ;;
  *'volume ls'*) printf '%s\\n' '${options.volumes ?? ""}' ;;
  *'volume inspect'*)
  case "$*" in
${inspectCases}
  esac ;;
  *'pg_dump'*) ${options.fail === "backup" ? "exit 19" : options.fail === "signal-backup" ? `printf partial-data; kill -TERM $PPID; exit 0` : `cat '${databaseState}'`} ;;
  *'pg_restore'*) ${options.fail === "signal-restore" ? `cat > /dev/null; kill -TERM $PPID; exit 0` : options.fail === "restore" ? `cat > '${databaseState}'; if [ ! -e '${base}/restore-failed-once' ]; then touch '${base}/restore-failed-once'; exit 20; fi` : `cat > '${databaseState}'`} ;;
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

  it("does not restore when the automatic pre-restore backup fails, and restarts the stopped stack", () => {
    const f = fixture({ fail: "backup" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("automatic pre-restore backup failed");
    const calls = readFileSync(f.log, "utf8");
    expect(calls).not.toContain("pg_restore");
    expect(calls.indexOf("stop web api")).toBeLessThan(calls.indexOf("pg_dump"));
    expect(calls.indexOf("pg_dump")).toBeLessThan(calls.indexOf("up -d"));
    expect(calls).not.toContain("migrate");
  });

  it("stops web and api before taking the pre-restore backup", () => {
    const f = fixture();
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).toBe(0);
    const calls = readFileSync(f.log, "utf8");
    expect(calls.indexOf("stop web api")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("stop web api")).toBeLessThan(calls.indexOf("pg_dump"));
    expect(calls.indexOf("pg_dump")).toBeLessThan(calls.indexOf("pg_restore"));
  });

  it("neither backs up nor restores when web/api cannot be stopped, and restarts the stack", () => {
    const f = fixture({ fail: "stop" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not stop web/API before restore");
    const calls = readFileSync(f.log, "utf8");
    expect(calls).not.toContain("pg_dump");
    expect(calls).not.toContain("pg_restore");
    expect(calls).toContain("up -d");
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
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
    const calls = commands(f.log);
    const stop = at(calls, "stop web api");
    const dump = at(calls, "pg_dump", stop);
    const restore = at(calls, "pg_restore", dump);
    const migrate = at(calls, "run --rm migrate", restore);
    const start = at(calls, "up -d", migrate);
    expect(start).toBeGreaterThan(migrate);
    expect(calls.slice(0, migrate).some((line) => line.includes("up -d"))).toBe(false);
  });

  it("recovers original data if migration of a restored backup fails", () => {
    const f = fixture({ fail: "migration-once" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restore migrations failed; original data recovered and stack restarted");
    const calls = commands(f.log);
    expect(calls.filter((line) => line.includes("pg_restore")).length).toBe(2);
    expect(calls.filter((line) => line.includes("run --rm migrate")).length).toBe(2);
    // stop, pre-restore backup, user restore, failing migrate; then recovery: stop again BEFORE the
    // pre-restore dump is restored, then migrate, then start.
    const firstStop = at(calls, "stop web api");
    const dump = at(calls, "pg_dump", firstStop);
    const userRestore = at(calls, "pg_restore", dump);
    const failedMigrate = at(calls, "run --rm migrate", userRestore);
    const recoveryStop = at(calls, "stop web api", failedMigrate);
    const recoveryRestore = at(calls, "pg_restore", recoveryStop);
    const recoveryMigrate = at(calls, "run --rm migrate", recoveryRestore);
    at(calls, "up -d", recoveryMigrate);
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
  });

  it("stops web and api again before restoring the pre-restore backup when the user restore fails", () => {
    const f = fixture({ fail: "restore" });
    expect(f.run("restore", "--confirm", f.backupFile).status).not.toBe(0);
    const calls = commands(f.log);
    const firstStop = at(calls, "stop web api");
    const dump = at(calls, "pg_dump", firstStop);
    const userRestore = at(calls, "pg_restore", dump);
    const recoveryStop = at(calls, "stop web api", userRestore + 1);
    const recoveryRestore = at(calls, "pg_restore", recoveryStop);
    const recoveryMigrate = at(calls, "run --rm migrate", recoveryRestore);
    expect(at(calls, "up -d", recoveryMigrate)).toBeGreaterThan(recoveryMigrate);
  });

  it("writes the dump to a .partial file and publishes the final name only after pg_dump succeeds", () => {
    const f = fixture();
    const shim = readFileSync(join(f.base, "bin/docker"), "utf8").replace(
      "*'pg_dump'*) cat",
      `*'pg_dump'*) ls '${f.base}/backups' > '${f.base}/during-dump.txt'; cat`,
    );
    writeFileSync(join(f.base, "bin/docker"), shim);
    const result = f.run("backup");
    expect(result.status).toBe(0);
    const final = result.stdout.trim();
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(final.endsWith(".dump")).toBe(true);
    expect(existsSync(final)).toBe(true);
    expect(existsSync(`${final}.partial`)).toBe(false);
    const during = readFileSync(join(f.base, "during-dump.txt"), "utf8").trim().split("\n");
    expect(during.length).toBe(1);
    expect(during[0]).toEndWith(".dump.partial");
    expect(Number.parseInt(statSync(final).mode.toString(8).slice(-3), 8) & 0o077).toBe(0);
  });

  it("leaves neither a final nor a partial file when the dump fails", () => {
    const f = fixture({ fail: "backup" });
    const result = f.run("backup");
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(f.base, "backups"))).toEqual([]);
  });

  it("leaves no partial or final file when SIGTERM arrives during the pre-restore backup", () => {
    const f = fixture({ fail: "signal-backup" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(f.base, "backups"))).toEqual([]);
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
  });

  it("on an interrupt before any restore begins, restarts the stack and names the stop state without recovering data", () => {
    const f = fixture({ fail: "signal-stop" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).toBe(143);
    expect(result.stderr).toContain("restore interrupted by SIGTERM");
    expect(result.stderr).toContain("no restore had begun; the stack was restarted");
    const calls = commands(f.log);
    at(calls, "up -d", at(calls, "stop web api"));
    expect(calls.some((line) => line.includes("pg_restore") || line.includes("run --rm migrate"))).toBe(false);
    expect(readFileSync(f.databaseState, "utf8")).toBe("fictional-live-before-restore\n");
  });

  it("on an interrupt during the restore, leaves the stack stopped, never replaces data, and prints the pre-restore backup", () => {
    const f = fixture({ fail: "signal-restore" });
    const result = f.run("restore", "--confirm", f.backupFile);
    expect(result.status).toBe(143);
    expect(result.stderr).toContain("restore interrupted by SIGTERM");
    expect(result.stderr).toContain("may be partially restored");
    expect(result.stderr).toContain("stack was left stopped");
    expect(result.stderr).toContain("pg_restore may still be running");
    expect(result.stderr).toContain("before retrying");
    const backup = result.stderr.match(/pre-restore backup retained at (.+)$/m)?.[1];
    expect(backup && existsSync(backup)).toBe(true);
    const calls = commands(f.log);
    expect(calls.filter((line) => line.includes("pg_restore")).length).toBe(1);
    expect(calls.some((line) => line.includes("up -d") || line.includes("run --rm migrate"))).toBe(false);
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

  describe("diagnose probes the public entry point", () => {
    it("passes only when API health, HTTPS through Caddy, and the WebSocket upgrade all pass", () => {
      const f = fixture();
      const result = f.run("diagnose");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("diagnose ok");
      const calls = readFileSync(f.log, "utf8");
      expect(calls).toContain("PROBE_KIND=https");
      expect(calls).toContain("PROBE_KIND=ws");
      expect(calls).toContain("PROBE_ORIGIN=https://localhost:18083");
      expect(calls).toContain("PROBE_TARGET=web");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-secret");
    });

    it("fails when the Caddy HTTPS probe fails even though internal API health succeeds", () => {
      const f = fixture({ fail: "probe-https" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-https]");
      expect(result.stderr).not.toContain("api-internal");
      expect(result.stdout).not.toContain("diagnose ok");
      expect(result.stderr).not.toContain("caddy-websocket");
    });

    it("fails when Caddy's CA cannot be read from the web container", () => {
      const f = fixture({ fail: "ca" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-ca]");
    });

    it("runs the WebSocket probe even when the HTTPS probe fails, and reports both", () => {
      const f = fixture({ fail: "probe-https" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-https]");
      expect(readFileSync(f.log, "utf8")).toContain("PROBE_KIND=ws");
      expect(result.stderr).not.toContain("caddy-websocket");
    });

    it("reports both FAILED lines when the HTTPS and WebSocket probes fail", () => {
      const f = fixture({ fail: "probe-both" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-https]");
      expect(result.stderr).toContain("FAILED [caddy-websocket]");
    });

    it("skips both Caddy probes only when the CA is unavailable, and says so", () => {
      const f = fixture({ fail: "ca" });
      const result = f.run("diagnose");
      expect(result.stderr).toContain("FAILED [caddy-ca]");
      expect(result.stderr).toContain("[caddy-https] and [caddy-websocket] were not checked");
      expect(readFileSync(f.log, "utf8")).not.toContain("PROBE_KIND");
    });

    it("does not mistake a probe exiting 2 for a CA failure", () => {
      const f = fixture({ fail: "probe-https-2" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-https]");
      expect(result.stderr).not.toContain("caddy-ca");
    });

    it("rejects a domain-mode origin carrying credentials without echoing them", () => {
      const f = fixture({ mode: "domain", origin: "https://fictional-user:fictional-pass@wooble.example.test" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must not contain credentials");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-pass");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("fictional-user");
      expect(existsSync(f.log) ? readFileSync(f.log, "utf8") : "").not.toContain("PROBE_KIND");
    });

    it("prints only scheme://host[:port] of the origin in FAILED lines", () => {
      const source = readFileSync(join(root, "deploy/wooble"), "utf8");
      const fn = source.match(/^display_origin\(\) \{[\s\S]*?^\}/m)?.[0];
      expect(fn).toBeDefined();
      for (const [input, shown] of [
        ["https://u:p@host.example:8443/path?token=x#frag", "https://host.example:8443"],
        ["https://host.example/?token=fictional-secret", "https://host.example"],
        ["https://fictional-user@host.example", "https://host.example"],
      ] as const) {
        const out = spawnSync("bash", ["-c", `${fn}\ndisplay_origin "$1"`, "bash", input], { encoding: "utf8" });
        expect(out.stdout).toBe(shown);
      }
    });

    it("fails when the WebSocket upgrade probe fails", () => {
      const f = fixture({ fail: "probe-ws" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [caddy-websocket]");
      expect(result.stderr).not.toContain("caddy-https");
    });

    it("reports the internal API layer separately when only internal health fails", () => {
      const f = fixture({ fail: "api-health" });
      const result = f.run("diagnose");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FAILED [api-internal]");
      expect(result.stderr).not.toContain("caddy-https");
    });

    it("does not read Caddy's CA in domain mode and still probes through Caddy", () => {
      const f = fixture({ mode: "domain", origin: "https://wooble.example.test" });
      const result = f.run("diagnose");
      expect(result.status).toBe(0);
      const calls = readFileSync(f.log, "utf8");
      expect(calls).not.toContain("exec -T web cat");
      expect(calls).toContain("PROBE_ORIGIN=https://wooble.example.test");
    });
  });

  describe("the extracted probe script against a local TLS server", () => {
    const apiUnauthorized = () => Response.json({ message: "Sign in to continue" }, { status: 401 });
    const handlers: Record<string, (request: Request, server: unknown) => Response | undefined> = {
      "api-401": apiUnauthorized,
      "wrong-401-body": () => Response.json({ message: "other" }, { status: 401 }),
      "html-401": () =>
        new Response("<html>Sign in to continue</html>", { status: 401, headers: { "content-type": "text/html" } }),
      "bad-gateway": () => new Response("Bad Gateway", { status: 502 }),
      "spa-html": () =>
        new Response("<!doctype html><title>Wooble</title>", { headers: { "content-type": "text/html" } }),
      "not-found": () => Response.json({ message: "not found" }, { status: 404 }),
      "ok-health": () => Response.json({ status: "ok" }),
      upgrade: (request, server) =>
        (server as { upgrade(request: Request): boolean }).upgrade(request)
          ? undefined
          : new Response("no", { status: 500 }),
    };
    let script = "";
    let certificate = "";
    let key = "";
    let directory = "";
    beforeAll(() => {
      script = readFileSync(join(root, "deploy/wooble"), "utf8").match(/<<'JS' \|\| true\n([\s\S]*?)\nJS\n/)?.[1] ?? "";
      directory = mkdtempSync(join(tmpdir(), "wooble-probe-test-"));
      temporaryRoots.push(directory);
      const made = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          join(directory, "k.pem"),
          "-out",
          join(directory, "c.pem"),
          "-days",
          "2",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { encoding: "utf8" },
      );
      expect(made.status).toBe(0);
      certificate = readFileSync(join(directory, "c.pem"), "utf8");
      key = readFileSync(join(directory, "k.pem"), "utf8");
    });
    async function probe(kind: "https" | "ws", handler: string, ca = certificate) {
      let seenPath = "";
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: { cert: certificate, key },
        fetch(request, self) {
          seenPath = new URL(request.url).pathname;
          return handlers[handler](request, self);
        },
        websocket: { message() {} },
      });
      try {
        const child = Bun.spawn(["bun", "-e", script], {
          stdin: new Blob([`${ca}\n`]),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PROBE_KIND: kind,
            PROBE_ORIGIN: `https://localhost:${server.port}`,
            PROBE_TARGET: "127.0.0.1",
            PROBE_PORT: String(server.port),
          },
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, code, seenPath };
      } finally {
        await server.stop(true);
      }
    }

    it("extracts the script", () => expect(script).toContain("PROBE_KIND"));

    it("accepts the API's JSON 401 for a random valid canvas UUID", async () => {
      const result = await probe("ws", "api-401");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("HTTP 401 JSON from the API access guard");
      expect(result.seenPath).toMatch(
        /^\/api\/canvases\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/live$/,
      );
    });

    it("accepts HTTP 101", async () => {
      const result = await probe("ws", "upgrade");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("HTTP 101");
    });

    for (const [handler, expected] of [
      ["bad-gateway", "unexpected HTTP 502"],
      ["spa-html", "unexpected HTTP 200"],
      ["not-found", "unexpected HTTP 404"],
      ["html-401", "unexpected HTTP 401"],
      ["wrong-401-body", "not the API's expected unauthorized body"],
    ] as const)
      it(`rejects ${handler} for the WebSocket probe`, async () => {
        const result = await probe("ws", handler);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(expected);
        expect(result.stdout).toBe("");
      });

    it("passes the HTTPS probe on 200 and fails it on 502", async () => {
      expect((await probe("https", "ok-health")).code).toBe(0);
      const bad = await probe("https", "bad-gateway");
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("unexpected HTTP 502");
    });

    it("keeps TLS verification on", async () => {
      const result = await probe("https", "ok-health", "");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("TLS/connection error");
    });
  });
});
