# Testing and coverage

Wooble has three test suites, and each one runs with Bun:

| Suite | Tests | Needs |
| --- | --- | --- |
| Web | `bun run test:web` (`apps/web/tests`) | Nothing extra; a happy-dom DOM is preloaded |
| Shared runtime | `packages/*/tests` | Nothing extra |
| API | `apps/api/tests` | An isolated, migrated PostgreSQL database in `DATABASE_URL`, whose user can create databases (for the upgrade test) |

Canvas and self-host browser journeys run separately with Playwright; see [CONTRIBUTING.md](../CONTRIBUTING.md#local-checks). API smoke tests and browser login tests prove different things: only the browser journey verifies the real web assets, browser-managed Secure/HttpOnly cookies, and login through Caddy.

## Self-host stack checks

`scripts/selfhost-cli-check.ts` performs static safety checks on `deploy/wooble`. `scripts/selfhost-image-check.ts` requires Docker and creates a fictional backup sentinel to check that it is excluded from the build context and final API image while checked-in SQL migrations remain present. The script removes only its own sentinel and temporary image.

The Self-hosted stack GitHub Actions workflow (`.github/workflows/docker.yml`) is configured to build a disposable source stack, verify its published ports and health, run API registration/canvas/WebSocket/Origin smoke, exercise browser login and static assets through local Caddy HTTPS, and rehearse backup/restore using fictional content. It then tests restart and persistence. Workflow configuration is not evidence of a completed GitHub Actions run; report the run URL/status and each phase result when it has actually run. Do not use these commands against a real installation or real account data.

To run the browser-specific journey against a disposable local Compose stack, start a stack using a supported HTTPS origin (for example `https://localhost:18083`), install Playwright's Chromium once, then run:

```sh
bun run --cwd apps/web playwright install chromium
SELFHOST_BROWSER_DISPOSABLE=1 \
  SELFHOST_BROWSER_ORIGIN=https://localhost:18083 \
  SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS=1 \
  bun run --cwd apps/web test:selfhost-browser
```

`SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS=1` is permitted only for loopback origins and a disposable stack using Caddy's local certificate. It does not turn off HTTPS or alter cookie policy. For a trusted certificate or a controlled domain, omit that option. The browser test creates one fictional registration, signs out, logs in again, checks static assets, and inspects the browser-set cookie attributes; it never injects a cookie. A successful API smoke test does not replace this browser test.

At this documentation checkpoint Docker/browser execution for the local self-host stack has not been available, and the new GitHub workflow has not been run. This section describes configured checks, not passed results.

## Writing web tests

`bun run test:web` preloads `apps/web/tests/support/dom.ts`, which registers a happy-dom browser environment and cleans up the DOM after each test. The preload applies only to the web suite: API tests need Bun's own `fetch`, `Request`, and `Response`. Test files are typechecked by `bun run typecheck` through `apps/web/tests/tsconfig.json`.

Helpers in `apps/web/tests/support/`:

- `renderRoute(path)` renders the real route tree (`src/routes/router.tsx`) with a fresh router and query cache, so route guards, redirects, and error pages run as in the browser. `renderWithQuery(ui)` renders a single component with query context.
- `FakeApi` replaces `fetch` with in-memory routes such as `server.on("PATCH /api/entities/:id", handler)`. It records every request, so tests can check what the app sent. `failWith(status, message)` returns the API's error shape.
- `FakeSocket` stands in for the live-canvas WebSocket. Tests open it, deliver presence messages, and read what the client sent.
- `fixtures.ts` holds fictional users, workspaces, and a small canvas graph.

Test behavior through roles, labels, and visible text. Assert on the requests a journey sends, not on component internals.

happy-dom does no layout, so the preload reports inline pixel sizes for elements and a `ResizeObserver` that fires once per observed element. This is enough for React Flow to measure and render nodes and edges. In canvas tests:

- Wait for the animated initial `fitView` to settle before converting canvas coordinates to screen coordinates.
- Node drags start on the first pointer move past a 1px threshold, so the drag helper nudges the pointer before moving it.

## Writing API tests

API tests call the Elysia app in process against the isolated database. `apiClient()` in `apps/api/tests/support/client.ts` registers fictional accounts with unique emails, promotes admins, and creates canvases, nodes, connections, and invitations. Registration and login share a per-IP rate limit across the suite, so call `resetLoginAttempts()` before each test that signs people in. Cover the permission matrix for a route: managers, editors, viewers, link visitors, outsiders, signed-out requests, and system admins where they differ.

A new route needs an access class in `routeAccess` (`apps/api/src/lib/auth.ts`) and an entry in the route list in `apps/api/tests/route-access.test.ts`; that test fails for any registered route missing from the list. To test a guard rule before a real route uses it, register a probe route with `apiClient({ configure })`.

Live-socket tests that use the raw client (`apps/api/tests/support/raw-websocket.ts`) prove frame isolation for a peer that never answers a close frame, not detach-before-close ordering: on Bun 1.3.14 the server's close handler runs synchronously inside `ws.close()`, so the two cannot be told apart. The terminate fallback timer is not observed by any test and is unverified.

## Database migrations and upgrades

Each release must upgrade from the previous one without losing content. Two checks guard this:

- `packages/db/tests/migrations.test.ts` runs without a database. It checks that the journal in `packages/db/drizzle/meta/_journal.json` is numbered contiguously, that its `when` timestamps strictly increase, that every entry has exactly one SQL file, and that migrations shipped in a release still match their recorded SHA-256. Drizzle applies a migration only when its timestamp is newer than the last one applied, so an out-of-order timestamp would be skipped silently on upgraded installations.
- `apps/api/tests/migration-upgrade.test.ts` creates a scratch database beside the API test database (see below). It migrates only up to the last migration of `v0.1.0`, writes fictional content through that schema (documentation, schema SQL, contract bodies, a node shown on two canvases, canvas events), applies the remaining migrations, and checks that the content is unchanged and that every journal entry ran. `apps/api/tests/support/migrations.ts` builds a temporary copy of the migrations folder for the partial run; checked-in files are never edited.

`scratchDatabase()` in `apps/api/tests/support/migrations.ts` creates one scratch database per run. The name is `wooble_p1_1_<test database>_<suffix>_<random token>`, cut to PostgreSQL's 63-byte identifier limit, because PostgreSQL would otherwise truncate a longer name with only a notice. It retries with a new name only when `CREATE DATABASE` reports a duplicate (SQLSTATE `42P04`); any other error fails the run. The handle it returns drops only the database that call created, never one it did not create, and it never terminates other sessions. Each statement runs on its own short-lived connection to the `postgres` database, and the test closes its own connections before it drops, so a drop does not meet the harness's own sessions. The drop has no `FORCE`, so it fails while another session is still connected to the scratch database, and it can be retried after that session closes. Parallel runs and agents can therefore share one PostgreSQL instance. If a run is killed, its database stays behind; the `wooble_p1_1_` prefix makes it recognisable in `pg_database`.

The `DATABASE_URL` user needs the `CREATEDB` privilege on a disposable instance. Never use the production app user for tests.

Run API tests with `bun test tests/*.test.ts` from `apps/api`. A bare `bun test`, or a filter such as `tests`, also picks up the ignored `apps/api/dist/tests` build output.

`apps/api/scripts/test-isolated.sh` does not work this way. It uses a fixed default database name (`architecture_canvas_test`, overridable with `TEST_DB_NAME`) and recreates it with `DROP DATABASE IF EXISTS ... WITH (FORCE)`, which ends any session connected to it. Two runs against the same instance and name drop each other's database, so give each run its own `TEST_DB_NAME` or instance.

When a branch adds a migration:

1. Generate the schema migration with `drizzle-kit generate`. If `main` gains another migration first, regenerate yours after merging `main` so it gets the next number and a newer timestamp. Never edit a migration that has been released or merged.
2. Keep hand-written data changes, such as copying existing values into a new table, in a separate custom migration (`drizzle-kit generate --custom`) that is never regenerated. Regenerating the schema migration would otherwise drop them.
3. Extend the upgrade test's seed and snapshot when the migration converts existing content, and assert the converted values.
4. When a release is tagged, add its migrations to the `released` hashes and, for the next release, add an upgrade case from that release.

## Running coverage locally

```sh
# Full run. DATABASE_URL must point at a disposable test database that has migrations applied.
DATABASE_URL=<test-database-url> bun run coverage

# Without a test database. API figures are skipped, and shared figures lose what API tests cover.
bun run coverage --without-api

# Also fail when an area is below its floor.
DATABASE_URL=<test-database-url> bun run coverage --enforce
```

CI runs each suite once, in its own step, and then reports on all of them:

```sh
bun run coverage --suite web       # also: shared, api (api needs DATABASE_URL)
bun run coverage --merge-only --enforce
```

`--suite` runs one suite with coverage and keeps its raw LCOV in `coverage/raw/<suite>/`. `--merge-only` builds the report from the suites already recorded there without running their tests again, and fails if any suite has no recorded coverage. Raw results from an older run are reused as they are, so rerun a suite after changing its tests or code.

`apps/api/scripts/test-isolated.sh` shows how to create and migrate a throwaway test database. Never point `DATABASE_URL` at a database whose data you want to keep.

The command writes:

- `coverage/summary.md`: area totals, every file below target, and the exclusion list. CI adds the same summary to the job page and uploads it as the `coverage-report` artifact.
- `coverage/lcov.info`: merged full-source LCOV for editor plugins and other tools.

## What the numbers mean

Coverage is reported for three areas, each against its own floor, so a well-tested area cannot hide a weak one:

| Area | Counted source |
| --- | --- |
| API | `apps/api/src/**/*.ts` |
| Web | `apps/web/src/**/*.{ts,tsx}` |
| Shared runtime | `packages/*/src/**/*.ts` |

The denominator is **every eligible production file**, not just the files tests happen to import. Plain `bun test --coverage` lists only loaded files, and its "All files" row averages per-file percentages. `bun run coverage` does three things instead:

1. It loads every eligible file once (`scripts/test-coverage/inventory.probe.ts`) to learn its executable lines and functions. The hits from this run are discarded.
2. It runs the web, shared, and API suites with coverage and merges their line hits.
3. A file that no behavioral test loads counts as 0%. Totals are weighted by line and function counts.

Bun reports function totals per file without function names. Merged function coverage is therefore the best single suite for each file, which is a lower bound.

Files with only type declarations have no executable lines and do not affect the numbers.

## Exclusions

Exclusions live in `scripts/test-coverage/areas.ts`, each with a reason, and are listed in every summary. Keep them narrow: process entry points, browser bootstrap, developer-only scripts, and placeholders without runtime behavior. Do not exclude a file because it is hard to test.

## Floors and the 90% target

The target is **90% lines and 90% functions in each area**. `thresholds` in `scripts/test-coverage/areas.ts` holds the floor CI enforces. API, web, and shared runtime code all meet the target and are held at 90/90, so `bun run coverage --enforce` fails if any area drops below 90% lines or 90% functions.

Do not lower a floor to make a change pass. Add tests for the new behavior instead, or document a narrow exclusion with its reason.

Write tests that assert behavior users or API clients depend on: success, error, permission, and persistence paths. Importing a file only to count it, or assertions that mirror the implementation, do not close a gap.
