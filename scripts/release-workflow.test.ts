import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release workflow safety and upgrade rehearsal", () => {
  test("keeps the exact v-prefixed install tag and limits publication to tag pushes", () => {
    expect(workflow).toContain('version="$REF_NAME"');
    expect(workflow).toContain('version="$INPUT_VERSION"');
    expect(workflow).toContain("publish=false");
    expect(workflow).toContain("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).toContain('gh release create "$VERSION" --draft --generate-notes');
    expect(workflow).toContain('"ghcr.io/dityath/wooble-api:$VERSION"');
    expect(workflow).toContain('"ghcr.io/dityath/wooble-web:$VERSION"');
  });

  test("fails on absent v0.1.0 source and verifies old app data through the upgraded API", () => {
    const smokeJob = workflow.indexOf("  build-and-smoke:");
    const setupBun = workflow.indexOf("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", smokeJob);
    const installDependencies = workflow.indexOf("bun install --frozen-lockfile", setupBun);
    const smokePhase = workflow.indexOf("Smoke API and static assets from the built images", installDependencies);
    const sourceCheck = workflow.indexOf("git rev-parse --verify 'v0.1.0^{commit}'");
    const archive = workflow.indexOf("git archive v0.1.0");
    const requiredFiles = workflow.indexOf('test -f "$RUNNER_TEMP/wooble-v010/compose.selfhost.yml"');
    const oldBuild = workflow.indexOf("-t wooble-api:v0.1.0", requiredFiles);
    const oldMigrate = workflow.indexOf("wooble-api:v0.1.0 bun run --cwd packages/db migrate", oldBuild);
    const oldApi = workflow.indexOf("--name wooble-old-api", oldMigrate);
    const oldHealth = workflow.indexOf("curl -fsS http://127.0.0.1:43003/health", oldApi);
    const oldReadinessFailure = workflow.indexOf("v0.1.0 API did not become healthy", oldHealth);
    const oldSetup = workflow.indexOf("SMOKE_BASE_URL=http://localhost:43003", archive);
    const currentMigration = workflow.indexOf("wooble-api:test bun run --cwd packages/db migrate", oldSetup);
    const currentApi = workflow.indexOf("--name wooble-new-api", currentMigration);
    const currentVerify = workflow.indexOf("scripts/selfhost-smoke.ts verify", currentApi);

    expect(sourceCheck).toBeGreaterThanOrEqual(0);
    expect(setupBun).toBeGreaterThan(smokeJob);
    expect(installDependencies).toBeGreaterThan(setupBun);
    expect(smokePhase).toBeGreaterThan(installDependencies);
    expect(archive).toBeGreaterThan(sourceCheck);
    expect(requiredFiles).toBeGreaterThan(archive);
    expect(workflow).toContain("wooble-release-upgrade-data:/var/lib/postgresql/data");
    expect(workflow).toContain("--name wooble-old-api");
    expect(workflow).toContain("--name wooble-new-api");
    expect(workflow).not.toContain("ghcr.io/dityath/wooble-api:v0.1.0");
    expect(oldBuild).toBeGreaterThan(requiredFiles);
    expect(oldMigrate).toBeGreaterThan(oldBuild);
    expect(oldApi).toBeGreaterThan(oldMigrate);
    expect(oldHealth).toBeGreaterThan(oldApi);
    expect(oldReadinessFailure).toBeGreaterThan(oldHealth);
    expect(oldSetup).toBeGreaterThan(oldReadinessFailure);
    expect(currentMigration).toBeGreaterThan(oldSetup);
    expect(currentApi).toBeGreaterThan(currentMigration);
    expect(currentVerify).toBeGreaterThan(currentApi);
  });
});
