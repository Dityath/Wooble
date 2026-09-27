# Code quality tooling

- Use Biome as the repository's linter and formatter. Do not add ESLint or Prettier unless explicitly requested.
- Treat `biome.json` as the source of truth. Biome lints JavaScript and TypeScript; CSS formatting is currently disabled to preserve the existing compact stylesheet.
- Run `bun run lint` and `bun run format:check` after relevant edits. Run `bun run typecheck` for TypeScript changes. Use `bun run format` to apply formatting.
- Keep the React Hooks and Fast Refresh checks active. If a rule needs an exception, scope it narrowly and explain why in the code or configuration.

# Repository guardrails

- Read the relevant code, contracts, tests, and documentation before editing. Keep changes focused on the accepted issue; preserve unrelated work and untracked files.
- Treat the semantic architecture model as the source of truth. Keep domain types, Zod contracts, database schema and migrations, API behavior, and web consumers aligned when changing their shared behavior.
- Preserve access control at the registered API route and scope reads and writes to the right workspace or canvas. Check guest links, viewers, editors, managers, and admins when a change touches authorization. Do not trust client-supplied roles, resource IDs, origins, or proxy headers without server-side validation.
- Use checked-in database migrations for schema changes. Do not run destructive database operations against a database with user data; use an isolated test database for integration tests. Do not silently change existing migration files.
- Do not commit secrets, real user or company data, private endpoints, or generated local environment files. Use fictional examples. Review the diff and staged files before committing.
- Add meaningful tests for changed behavior. Run the relevant checks and report what ran, what failed, and any browser, database, or deployment validation that remains unproven. For UI changes, verify the affected journey in a browser when possible.
- Never claim a command, review, CI run, deployment, or user approval happened unless it actually did. Do not push, publish, rewrite shared history, or remove user data without authorization.

# AI-assisted contributions

- For substantial AI-assisted changes, strongly prefer two separate agents: an implementation agent and an independent review agent. The reviewer examines the final diff, tests, security and access implications, and documentation; the implementer resolves findings before the PR. A human contributor remains responsible for the submitted change.
- Both agents follow these guardrails. See `docs/ai-agents.md` for the workflow and PR disclosure.
