# Testing and coverage

Wooble has three test suites, and each one runs with Bun:

| Suite | Tests | Needs |
| --- | --- | --- |
| Web | `bun run test:web` (`apps/web/tests`) | Nothing extra; a happy-dom DOM is preloaded |
| Shared runtime | `packages/*/tests` | Nothing extra |
| API | `apps/api/tests` | An isolated, migrated PostgreSQL database in `DATABASE_URL` |

Canvas browser journeys run separately with Playwright; see [CONTRIBUTING.md](../CONTRIBUTING.md#local-checks).

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
