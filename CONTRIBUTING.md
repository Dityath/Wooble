# Contributing to Wooble

Thanks for helping improve Wooble. The project welcomes code, documentation, design, and product ideas. Read [what Wooble is](docs/product.md), the [architecture](docs/architecture.md), and the [brand guide](docs/brand.md) before making a larger change. If you use AI to contribute, follow the [AI agent guide](docs/ai-agents.md) and the repository [guardrails](AGENTS.md).

## Contribution flow

1. **Report or discuss an issue.** Describe the problem, expected behavior, and evidence. For a feature, explain the user journey and how it fits the semantic architecture model.
2. **Wait for scope acceptance on substantial work.** A maintainer will confirm that the issue is ready. Comment to claim it so others know you are working on it. Small typo and documentation fixes may go straight to a PR.
3. **Fork the repository** and create a focused branch.
4. **Make the change.** Keep data contracts, API routes, and web consumers aligned. Add or update meaningful tests for behavior you changed.
5. **Review your own diff.** Check the change manually. For AI-assisted work, two separate agents are strongly recommended: one to implement and another to independently review the diff. Resolve the review findings yourself. For UI changes, include screenshots or a short recording and verify the interaction in a browser.
6. **Open a pull request** linked to the issue. Explain what changed, why, how you tested it, and any limitations or migration steps. If AI was used, describe its role and whether a separate review agent examined the final diff.
7. **Respond to review.** The maintainer decides when the PR is ready to merge.

## Local checks

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
bun run build
bun test apps/web/tests
```

API tests need an isolated PostgreSQL database. See [self-hosting](docs/self-hosting.md) for the database setup and `apps/api/scripts/test-isolated.sh` for the test database workflow. Do not point the isolated test script at a database containing data you want to keep: it recreates its target database.

Biome is the repository linter and formatter. Run `bun run format` when formatting needs to be applied. CSS formatting is disabled in `biome.json` to preserve the existing stylesheet.

## Contribution rights

By submitting a contribution, you confirm that you have the right to release it under [the repository's public domain terms](LICENSING.md). Do not submit company code, data, images, or credentials without permission. Dependencies and third-party marks retain their own terms.
