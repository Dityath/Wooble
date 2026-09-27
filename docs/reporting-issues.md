# Reporting and choosing issues

GitHub Issues is where Wooble tracks bugs, product proposals, and planned work. Search [open and closed issues](https://github.com/Dityath/Wooble/issues) before opening a new one. Choose **Bug report**, **Feature proposal**, or **Task** from the issue form chooser. For a question that does not fit those forms, use a blank issue and explain the context.

## What to include

- **Clear title:** describe the observed problem or desired outcome, not a proposed code change alone.
- **What to solve:** who is affected, which workspace or canvas role is involved, what happens today, and why it matters.
- **How:** for a bug, give steps to reproduce and expected behavior. For a proposal or task, describe the desired user journey or a suggested approach; you do not need to know the exact implementation.
- **Evidence:** include browser/Bun version when relevant, and a screenshot or a small fictional example.
- **Scope:** identify the affected page, API route, contract, or deployment path if you know it. It is fine to say you are unsure.

Do not post credentials, private URLs, real customer data, or security exploit details in a public issue. Replace identifiers and data with fictional examples. To report a vulnerability, open [Security advisories](https://github.com/Dityath/Wooble/security/advisories) and choose **Report a vulnerability**; private vulnerability reporting is enabled for this repository.

## Categories and triage

Wooble uses **labels** to group issues in this personal-account repository. A label can describe the kind of work, the affected area, or its triage state. Maintainers apply and adjust labels; reporters do not need to guess every category.

| Label group | Labels | Use |
| --- | --- | --- |
| Kind | `bug`, `enhancement`, `documentation`, `question`, `task` | What sort of request is this? The first four use GitHub's default labels. |
| Area | `area:api`, `area:web`, `area:data`, `area:testing`, `area:self-hosting`, `area:design`, `area:docs`, `area:product` | Which part of Wooble is affected? More than one may apply. |
| State | `status:needs-triage`, `status:ready`, `status:claimed` | Is the scope still being discussed, accepted for work, or claimed by a contributor? |

The existing `good first issue` and `help wanted` labels can highlight suitable contributions. Do not use `good first issue` for a large or security-sensitive task merely because it is unassigned.

## From report to pull request

1. A maintainer checks for duplicates, asks for missing evidence, and agrees on scope and acceptance criteria.
2. When the issue is ready, the maintainer changes `status:needs-triage` to `status:ready`. Comment to claim substantial work; the maintainer marks it `status:claimed` so others can see it is in progress.
3. Follow [CONTRIBUTING.md](../CONTRIBUTING.md), link the issue from the PR, and report the checks you actually ran. A maintainer reviews and closes the issue when the work is accepted.

For broad work, keep one tracking issue and split independent implementation areas into smaller linked issues. A coverage goal, for example, can track separate API, web, and measurement tasks without forcing one contributor to own the entire effort.
