/**
 * Build the API image with a fictional backup sentinel and prove that the
 * sentinel is excluded while Drizzle SQL migrations remain in the image.
 *
 * Run from the repository root: bun scripts/selfhost-image-check.ts
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = resolve(import.meta.dir, "..");
const sentinelName = `.selfhost-image-check-${crypto.randomUUID()}.dump`;
const sentinelRelativePath = join("backups", sentinelName);
const sentinelPath = join(root, sentinelRelativePath);
const sentinelContent = `fictional image-check sentinel ${crypto.randomUUID()}\n`;
const imageTag = `wooble-selfhost-image-check:${crypto.randomUUID()}`;
const webImageTag = `wooble-selfhost-image-check-web:${crypto.randomUUID()}`;
const backupsDirectory = join(root, "backups");
let createdBackupsDirectory = false;
let sentinelCreated = false;

let imageCreated = false;
let webImageCreated = false;
try {
  check(!existsSync(sentinelPath), "Refusing to overwrite an existing sentinel path");
  if (!existsSync(backupsDirectory)) {
    mkdirSync(backupsDirectory);
    createdBackupsDirectory = true;
  }
  writeFileSync(sentinelPath, sentinelContent, { flag: "wx", mode: 0o600 });
  sentinelCreated = true;

  // This throwaway build uses the same build context and a COPY of the unique
  // sentinel. Docker must reject that COPY because .dockerignore removes it.
  const contextProbe = run("docker", ["build", "--no-cache", "--progress=plain", "-f", "-", "."], {
    input: `FROM scratch\nCOPY ${sentinelRelativePath} /sentinel\n`,
  });
  check(contextProbe.status !== 0, "The sentinel was visible in the Docker build context");
  check(
    `${contextProbe.stdout}\n${contextProbe.stderr}`.includes(sentinelName),
    "The context probe failed for a reason other than the excluded sentinel",
  );
  console.log("Build context passed: Docker could not COPY the backup sentinel");

  // deploy/Dockerfile ends with the Caddy "web" stage, so every build names its target.
  const build = run("docker", [
    "build",
    "--no-cache",
    "--target",
    "api",
    "-f",
    "deploy/Dockerfile",
    "-t",
    imageTag,
    ".",
  ]);
  check(build.status === 0, "API image build failed");
  imageCreated = true;

  const inspect = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "bun",
    "-e",
    `SELFHOST_SENTINEL_PATH=/app/backups/${sentinelName}`,
    imageTag,
    "-e",
    `
      import { existsSync, readdirSync } from "node:fs";
      const sentinel = process.env.SELFHOST_SENTINEL_PATH;
      if (existsSync(sentinel)) throw new Error("Backup sentinel was copied into the API image");
      const migrationsPath = "/app/packages/db/drizzle";
      const migrations = readdirSync(migrationsPath).filter((name) => name.endsWith(".sql"));
      if (migrations.length === 0) throw new Error("No SQL migrations are present in the API image");
      console.log("API image passed: backup sentinel absent; SQL migrations present: " + migrations.join(", "));
    `,
  ]);
  check(inspect.status === 0, "API image inspection failed");

  // The web image is the Caddy stage: it has no bun, so inspect it with busybox sh.
  const webBuild = run("docker", [
    "build",
    "--no-cache",
    "--target",
    "web",
    "-f",
    "deploy/Dockerfile",
    "-t",
    webImageTag,
    ".",
  ]);
  check(webBuild.status === 0, "Web image build failed");
  webImageCreated = true;
  const webInspect = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    webImageTag,
    "-c",
    `test ! -e "/srv/backups/${sentinelName}" && test ! -e "/srv/${sentinelName}" && test ! -e /srv/backups && test -f /srv/index.html && test -f /etc/caddy/Caddyfile && echo "Web image passed: backup sentinel absent; static assets and Caddyfile present"`,
  ]);
  check(webInspect.status === 0, "Web image inspection failed");
} finally {
  try {
    for (const [created, tag] of [
      [imageCreated, imageTag],
      [webImageCreated, webImageTag],
    ] as const) {
      if (!created) continue;
      const removal = run("docker", ["image", "rm", "--force", tag]);
      if (removal.status !== 0) console.error(`Could not remove temporary image ${tag}`);
    }
  } finally {
    if (sentinelCreated && existsSync(sentinelPath)) unlinkSync(sentinelPath);
    if (createdBackupsDirectory && existsSync(backupsDirectory) && readdirSync(backupsDirectory).length === 0)
      rmdirSync(backupsDirectory);
  }
}
