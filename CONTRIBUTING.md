# Contributing to Wooble

Thanks for helping improve Wooble. The project welcomes code, documentation, design, and product ideas. Read [what Wooble is](docs/product.md), the [architecture](docs/architecture.md), and the [brand guide](docs/brand.md) before making a larger change. If you use AI to contribute, follow the [AI agent guide](docs/ai-agents.md) and the repository [guardrails](AGENTS.md).

## Contribution flow

1. **Report or discuss an issue.** Follow the [issue reporting guide](docs/reporting-issues.md) and choose the matching GitHub form. Describe the problem, expected behavior, and evidence. For a feature, explain the user journey and how it fits the semantic architecture model.
2. **Wait for scope acceptance on substantial work.** A maintainer will confirm that the issue is ready. Comment to claim it so others know you are working on it. Small typo and documentation fixes may go straight to a PR.
3. **Fork the repository** and create a focused branch.
4. **Make the change.** Keep data contracts, API routes, and web consumers aligned. Add or update meaningful tests for behavior you changed.
5. **Review your own diff.** Check the change manually. For AI-assisted work, two separate agents are strongly recommended: one to implement and another to independently review the diff. Resolve the review findings yourself. For UI changes, include screenshots or a short recording and verify the interaction in a browser.
6. **Open a pull request** linked to the issue and fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Explain what problem it solves, how the change solves it, how you tested and reviewed it, and any limitations or migration steps.
7. **Respond to review.** The maintainer decides when the PR is ready to merge.

## Local checks

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
bun run build
bun run test:web
bun test packages/*/tests
```

Run `bun run coverage` to see full-source coverage for the API, web app, and shared packages. CI fails when an area drops below its floor. See [testing and coverage](docs/testing.md) for the commands and what the numbers measure.

API tests need an isolated PostgreSQL database. See [self-hosting](docs/self-hosting.md) for the database setup and `apps/api/scripts/test-isolated.sh` for the test database workflow. Do not point the isolated test script at a database containing data you want to keep: it recreates its target database.

Canvas browser tests also need a separate, migrated PostgreSQL database and Playwright Chromium. Run `bunx playwright install chromium` once, then run `BROWSER_TEST_DATABASE_URL=<test-database-url> bun run --cwd apps/web test:browser`. The browser test command requires this variable and refuses to reuse an existing API or web server. Its fixtures create fictional users and canvases in the test database and leave them there for inspection; use a disposable database.

Self-host browser login is a separate journey from canvas browser tests. It needs a running disposable self-host Compose stack at an HTTPS origin and Playwright Chromium. For local Caddy TLS, the HTTPS-error override is restricted to loopback:

```sh
bun run --cwd apps/web playwright install chromium
SELFHOST_BROWSER_DISPOSABLE=1 \
  SELFHOST_BROWSER_ORIGIN=https://localhost:18083 \
  SELFHOST_BROWSER_IGNORE_HTTPS_ERRORS=1 \
  bun run --cwd apps/web test:selfhost-browser
```

This test loads the actual static web assets through Caddy, registers a fictional account, checks the browser-created Secure/HttpOnly session cookie, signs out, and logs in again. It does not inject a cookie. API smoke tests that call registration/login directly prove API behavior, not the browser cookie or Caddy journey. Use only fictional data and a disposable stack.

Pull requests touching the application, deployment, Compose, image-check, or self-host scripts are configured to run the **Self-hosted stack** workflow (`.github/workflows/docker.yml`). It builds the source stack with a throwaway environment, checks the API image/build-context backup exclusion and SQL migrations, runs CLI static checks, verifies HTTPS health and that only the web service publishes a loopback port, then exercises API registration/canvas edits/live presence/foreign-Origin rejection, browser login through Caddy, backup and confirmed restore, API restart, and persistence across stop/start. The workflow's configuration is not a passed GitHub run; check the Actions result for the branch/commit. Docker/browser runtime, fresh-host, second-device, domain HTTPS, and multi-architecture results must be reported separately. Never run these checks against an installation with real users because they create fictional accounts and mutate a smoke canvas.

The release workflow is a separate path. Its tag/manual dry-run behavior and architecture results must be read from the actual workflow and GitHub run; do not infer a passing release from CI configuration or a local source build. See [versioning](versioning.md) and [self-hosting](self-hosting.md) for exact image tags, maintainer GHCR package visibility setup, and release limitations.

Biome is the repository linter and formatter. `bun run lint` treats warnings as errors, so CI fails on any lint warning. Run `bun run format` when formatting needs to be applied. CSS formatting is disabled in `biome.json` to preserve the existing stylesheet.

## Contribution rights

By submitting a contribution, you confirm that you have the right to release it under [the repository's public domain terms](LICENSING.md). Do not submit company code, data, images, or credentials without permission. Dependencies and third-party marks retain their own terms.
