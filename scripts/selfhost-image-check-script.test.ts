import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

// A fake docker on PATH records every call. The context probe (`-f -`) fails and echoes
// its Dockerfile, which names the sentinel, exactly as a real excluded COPY would.
function runImageCheck() {
  const base = mkdtempSync(join(tmpdir(), "wooble-image-check-test-"));
  temporaryRoots.push(base);
  const log = join(base, "calls.log");
  const docker = join(base, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *'-f -'*) cat >&2; exit 1 ;;
  *'--target api'*|*'--target web'*) exit 0 ;;
  *'deploy/Dockerfile'*) echo 'built the last stage (caddy), which has no bun' >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  const result = spawnSync("bun", [join(root, "scripts/selfhost-image-check.ts")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${base}:${process.env.PATH}` },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { result, calls };
}

describe("selfhost-image-check.ts docker invocations", () => {
  it("names an explicit target for every build of deploy/Dockerfile", () => {
    const { result, calls } = runImageCheck();
    expect(result.status).toBe(0);
    const builds = calls.filter((call) => call.includes("-f deploy/Dockerfile"));
    expect(builds.length).toBe(2);
    expect(builds.some((call) => call.includes("--target api"))).toBe(true);
    expect(builds.some((call) => call.includes("--target web"))).toBe(true);
    for (const call of builds) expect(call).toMatch(/--target (api|web)\b/);
  });

  it("runs bun only in the api image and busybox sh in the web image", () => {
    const { calls } = runImageCheck();
    const runs = calls.filter((call) => call.startsWith("run "));
    expect(runs.filter((call) => call.includes("--entrypoint bun")).length).toBe(1);
    expect(runs.filter((call) => call.includes("--entrypoint sh")).length).toBe(1);
  });

  it("removes both temporary images", () => {
    const { calls } = runImageCheck();
    expect(calls.filter((call) => call.startsWith("image rm --force")).length).toBe(2);
  });
});
