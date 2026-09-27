# Coding with AI agents

AI agents can help implement and review Wooble contributions. For substantial AI-assisted work, **use at least two distinct agents when available**: one implements the change, and a second independently reviews the final diff. A small documentation or typo fix can use a simpler workflow. Agent output is evidence to inspect, not approval to merge; the human contributor and maintainer remain accountable.

Every agent working in this repository must follow [AGENTS.md](../AGENTS.md), the issue's accepted scope, and the same [contribution flow](../CONTRIBUTING.md) as any other contributor.

## Suggested workflow

1. **Define the task.** Link the accepted issue, expected user journey, affected areas, and acceptance criteria. Ask an agent to inspect the relevant code and tests before editing.
2. **Implementation agent.** Make a focused change. Keep domain types, contracts, database schema, API routes, and web consumers consistent. Update docs and meaningful tests where behavior changes. Record the commands and manual checks actually performed.
3. **Review agent.** Use a separate agent or fresh context. Give it the issue, guardrails, and final diff. Ask it to look for behavioral regressions, security and access gaps, data or migration risks, incomplete tests, documentation errors, and unrelated changes. It should report findings with file and line references and distinguish verified defects from questions.
4. **Resolve and verify.** The contributor evaluates each finding, fixes real problems, and reruns relevant checks. If the diff changes materially, have the reviewer inspect the final version again.
5. **Open the PR.** State what the agents did, whether an independent agent reviewed the final diff, which checks ran, and what remains unverified. The maintainer reviews and decides whether to merge.

Two agents may run sequentially; they do not need to edit concurrently. Prefer a reviewer that did not author the change and has no reason to defend its implementation. An AI review supplements your own diff review and the maintainer's review.

## Review checklist

- Does the behavior meet the accepted issue and preserve related user journeys?
- Are API contracts, validation, persistence, and UI consumers consistent?
- Are workspace and canvas roles, public links, cookies, origins, and resource scopes still enforced by the server?
- Are migrations safe for existing data, and are transaction or concurrency claims backed by database tests?
- Are UI states and interactions checked in a browser when the change affects them?
- Are tests meaningful, and are lint, format, typecheck, build, and relevant tests reported accurately?
- Does the diff contain secrets, private data, internal names, generated files, or unrelated edits?
- Do the README and feature docs describe current behavior and future direction accurately?

## Practical limits

Do not paste secrets or private customer data into an agent prompt. Do not let an agent run destructive database commands, publish a branch, rewrite shared Git history, or deploy without the contributor's authorization. If two agents are unavailable, disclose that in the PR and perform a careful manual review; a second agent is strongly recommended, not a CI gate.
