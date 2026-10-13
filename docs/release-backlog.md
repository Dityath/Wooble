# Release backlog and acceptance evidence

## Scope and how to read this

This is evidence and tracking, **not an implementation report, code approval or release claim**.
The roadmap and the five draft release cards remain the acceptance authority. This revision
supersedes the earlier six-issue write plan; it does not retroactively change the earlier
snapshot. No GitHub write, commit, merge or runtime edit was made by this documentation task.

**Planned ≠ active ≠ PR draft ≠ merged ≠ released.** An accepted issue is not automatically
active; a branch alone does not establish release completion. An active local ADR may be claimed
without being approved or on `main`. An open draft PR is active work, not merged work.
`status:claimed` tracks that verified activity; it does **not** assign a human. No assignee,
milestone or date will be invented. New design/dependency-blocked work is `status:needs-triage`.

The interim storage ADR for #16 was read from another branch. It is not on `main` and is not the
full collaboration ADR. Another agent owns that local ADR/spike; its existence, SHA and results
must be read back before recording them. This file makes no collaboration-model decision.

The write plan covers v0.2–v0.5 only. **Keep exactly five draft release cards; add no Project
implementation items.** Use issue/PR links in the existing card bodies. **v0.6 is not edited**:
no body, status, dates, title or new v0.6 issues. Shared self-hosting work remains an unmet gate,
not an automatic completion claim.

## Dated snapshots and completeness

### Historical snapshot — 2026-10-13T02:35:11Z

The initial read recorded `main = 4b5fa0a73baba300004da5caf661080c8750e4ab`, 8 open draft PRs,
13 PRs in all states (5 merged), 18 issues (16 open, 2 closed), 5 draft Project items all Todo,
15 Project fields, 22 labels and 1 release. This is historical evidence, not a newly asserted
timestamp. The earlier plan incorrectly prohibited all claimed labels, limited new work to six
issues and omitted v0.3–v0.5 implementation issues; those restrictions are withdrawn here.

### Revision refresh — 2026-10-13T02:56:49Z–2026-10-13T02:58:42Z

Live reads confirmed **no remote change** in the quantities, heads, bases, labels, reviews,
release cards, required checks or release list recorded below. Commands were run in this
worktree; equivalent replay commands are listed verbatim. No large body was shell-interpolated:
individual bodies were read as JSON. Scalar head SHAs only were used in the check API loop.

| Read command | Exact returned count / result |
| --- | --- |
| `gh pr list --repo Dityath/Wooble --state open --limit 100 --json number,title,body,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,closingIssuesReferences,statusCheckRollup,reviews,updatedAt` | 8; all drafts; titles, bodies, bases and heads unchanged |
| `gh pr list --repo Dityath/Wooble --state all --limit 100 --json number,state,mergedAt` | 13: 8 open, 5 merged (#1, #2, #5, #7, #8) |
| `gh issue list --repo Dityath/Wooble --state all --limit 200 --json number,title,state,labels,assignees,milestone,projectItems,updatedAt` | 18: 16 open, 2 closed (#3, #4) |
| `gh issue view <n> --repo Dityath/Wooble --json number,title,body,labels` | 1 each for #9–#19, 11 individually read bodies; original snapshot individually read all 18 |
| `gh project item-list 1 --owner Dityath --limit 100 --format json` | 5 returned, `totalCount: 5`; all DraftIssue, all Todo |
| `gh project field-list 1 --owner Dityath --format json` | 15 returned, `totalCount: 15` |
| `gh project view 1 --owner Dityath --format json` | 1 project; public; 5 items; ID below |
| `gh label list --repo Dityath/Wooble --limit 100 --json name` | 22; required existing categories/labels present |
| `gh release list --repo Dityath/Wooble --limit 30` | 1: `Wooble v0.1.0 — Preview`, Pre-release, tag v0.1.0, published 2026-09-28T08:25:17Z |
| `gh api repos/Dityath/Wooble/commits/main --jq .sha` | `4b5fa0a73baba300004da5caf661080c8750e4ab` |
| `gh repo view Dityath/Wooble --json defaultBranchRef,visibility` | default `main`; PUBLIC |
| `gh api repos/Dityath/Wooble/branches/main/protection/required_status_checks` | succeeded: `strict: true`; Code quality and Tests; both app_id 15368 |
| `gh api --paginate 'repos/Dityath/Wooble/commits/<head-sha>/check-runs?per_page=100'` | #24–#28 and #30: 2 returned/total each; #29/#31: 3 returned/total each |
| `gh pr view <n> --repo Dityath/Wooble --json number,headRefOid` | 1 each for #24–#31, after its checks read; each matched fetched check `head_sha` |

No list reached its limit: 8/100 open PRs, 13/100 all PRs, 18/200 issues, 5/100 items,
22/100 labels, 1/30 releases. Fields report 15/15 total. Check API used `--paginate`, with
returned counts equal to `total_count`; no further check page was needed. PR numbers
#1/#2/#5/#7/#8 are not repository issues. Reads of a singleton are not paginated lists.

### Verified Project IDs, dates and status

Project `PVT_kwHOA0GxUM4Bk_Ik`; Status field `PVTSSF_lAHOA0GxUM4Bk_Ikzhjtqzk`.
Options: Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657`.

| Release title (unchanged) | Item ID / draft content ID | Current status | Existing start / target |
| --- | --- | --- | --- |
| v0.2.0 — Collaborative documentation | `PVTI_lAHOA0GxUM4Bk_Ikzg9Rc_E` / `DI_lAHOA0GxUM4Bk_IkzgLOXXQ` | Todo | 2026-09-29 / 2026-10-10 |
| v0.3.0 — API and Protobuf contracts | `PVTI_lAHOA0GxUM4Bk_Ikzg9Rdtg` / `DI_lAHOA0GxUM4Bk_IkzgLOXYc` | Todo | 2026-10-11 / 2026-10-24 |
| v0.4.0 — Database diagrams | `PVTI_lAHOA0GxUM4Bk_Ikzg9Rdvs` / `DI_lAHOA0GxUM4Bk_IkzgLOXYk` | Todo | 2026-10-25 / 2026-11-07 |
| v0.5.0 — Comments and discussion | `PVTI_lAHOA0GxUM4Bk_Ikzg9Rdy4` / `DI_lAHOA0GxUM4Bk_IkzgLOXYo` | Todo | 2026-11-08 / 2026-11-21 |
| v0.6.0 — Stability and user experience | `PVTI_lAHOA0GxUM4Bk_Ikzg9Rd2E` / `DI_lAHOA0GxUM4Bk_IkzgLOXY0` | Todo | 2026-11-22 / 2026-12-05 |

v0.2's October 10 target was already overdue at both reads; it is revisable and unchanged.
Only v0.2's planned status is In Progress, based on #9's active editor branch and #13/#25.
v0.3–v0.5 stay Todo despite shared foundation PRs. v0.6 is **NOT EDITED**.

`strict: true` requires PR branches to be up to date for required checks; it is not a rule that
allows direct pushes. Branch protection requires **Code quality** and **Tests** only.
Browser journeys and Docker smoke test are advisory; their green results do not satisfy a
release's integrated journey, and advisory does not mean their failures should be ignored.

## PR ↔ issue mapping and SHA-specific remote evidence

All eight remain draft, unmerged, with **zero submitted GitHub reviews**. A review described in
a PR body is contributor-reported evidence, not a submitted approval. The historical query
reported MERGEABLE/CLEAN; that does not establish acceptance. Below, CQ = Code quality and
T = Tests; both are completed/success on **the full head SHA in that row**. No older SHA's green
result is reused. Refresh check reads and subsequent PR reads matched for every row.

| PR / exact title | Issue / closingIssuesReferences | Head branch | Full head SHA | Base / stacked | Checks on that exact SHA; returned/total | Carried-over maintainer notes |
| --- | --- | --- | --- | --- | --- | --- |
| #24 Keep database backups out of images and Git | #17 / [17] | `fix/issue-6-keep-backups-out-of-images` | `c145c4a043354b29f4034cfdcaecf39ea00d73e3` | main / no | CQ, T success; 2/2 | Local Docker context not run; operators must move old backups before rebuilding. No source blocker identified is not approval. |
| #25 Show connection documentation to viewers and link guests | #13 / [13] | `fix/issue-13-viewer-connection-documentation` | `63920de9f5c99106830625001cb8a260d1f07bcf` | main / no | CQ, T success; 2/2 | Reconcile MarkdownContent import after #9; author reports browser tests. No source blocker identified is not approval. |
| #26 Deny unclassified API routes and check live socket access on open | #10 / [10] | `fix/issue-10-access-guard-default-deny` | `5ecc77a303a2e9c6a5d517b2540011ea445f4cbf` | main / no | CQ, T success; 2/2 | Author-reported review fixes do not dispose of the supplied local fail-closed recheck finding below. |
| #27 Require read access before placing an entity on another canvas | #11 / [11] | `fix/issue-11-placement-requires-entity-access` | `85124559303a142cb0f2d3fc42e8f79323ac5c8f` | main / no | CQ, T success; 2/2 | Separate multi-canvas write-rule decision remains open; original #11 scope unchanged. |
| #28 Add a migration upgrade test from v0.1.0 and journal checks | #15 / [15] | `test/issue-15-migration-upgrade-harness` | `4f56d2460460edf015616d3911d8f27ea60f7962` | main / no | CQ, T success; 2/2 | Requires database-creation privileges; supplied parallel/pre-drop finding below remains unresolved here. |
| #29 Run the browser journeys in CI | #14 / [14] | `chore/issue-14-ci-browser-journeys` | `365f454163708219f5d0f4c0d1bbe830c70571f2` | main / no | CQ, T, Browser journeys success; 3/3 | Green isolated CI is not evidence for the combined editor branch; production-build browser project deferred by author. |
| #30 Validate WEB_ORIGIN and runtime configuration at startup | #18 / [] (body says Closes #18) | `fix/issue-6-origin-and-runtime-config-checks` | `407902c22e964849385e5bd8b8fcad1af40e8bdb` | `fix/issue-10-access-guard-default-deny` / yes, #26 | CQ, T success; 2/2 | Base SHA is #26's head; release notes need configuration failures; supplied raw-origin diagnostic finding below not resolved here. |
| #31 Smoke-test the self-hosted Docker stack in CI | #19 / [19] | `chore/issue-6-docker-smoke-ci` | `6673e2a414e944f00a3f9b6805ca2f507eb3430e` | main / no | CQ, T, Docker smoke test success; 3/3 | CI smoke is real remote evidence, not browser, second-device or previous-release upgrade validation. |

All main bases are `4b5fa0a73baba300004da5caf661080c8750e4ab`; #30's base is
`5ecc77a303a2e9c6a5d517b2540011ea445f4cbf`, exactly #26's head at refresh.

### #30's closing references

GitHub interprets closing keywords for PRs targeting the default branch only
([documented behavior](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)).
The empty array is therefore expected while #30 targets #26's branch. Track #18 manually in
the body now, without pretending the API supplied a closing reference. **If #30 is retargeted
to main, re-fetch its base, head, checks and closingIssuesReferences:** Closes #18 may then be
interpreted and close #18 on merge. Do not predict that it can never close #18, nor assume a
stack merge automatically closes it. Merging/retargeting/closing is not authorized here.

### Supplied LOCAL AUDIT findings, separate from REMOTE evidence

These are the revision brief's supplied local audit findings, not tests run by this task, not
GitHub reviews and **not claims that the remote PR has been fixed**. The executor carries the
following exact, requirement-level notes in owned tracking sections, preserving original PR
bodies and issue acceptance. Maintainer re-review and per-SHA regression evidence are needed.

| PR | Local audit note to carry forward | Remote evidence does not prove |
| --- | --- | --- |
| #24 / #25 | No source blocker identified by the supplied audit; this is NOT approval. #25 still needs the import reconciliation with #9. | Acceptance, combined-branch browser behavior or permission coverage for future live documents. |
| #26 | Open finding: immediate access rechecks must fail closed when revalidation cannot complete; require a regression proving no continuing unauthorized live session. | That a green Code quality/Tests run covers this failure path. |
| #28 | Open finding: make parallel upgrade tests deterministic and record pre-drop evidence before cleanup of their isolated databases. | Parallel determinism or inspectable evidence just because the existing upgrade test passed. |
| #30 | Open finding: raw WEB_ORIGIN diagnostics must not echo sensitive raw configuration; regress the sanitized diagnostic behavior. | That all invalid-origin diagnostics are safely redacted. |
| #29 | Browser journeys is green on this PR's head, not on the combined editor work. | Combined editor, co-editing, import/export or new release journey validation. |
| #31 | Docker smoke is green on this PR's head; browser, second-device and previous-release upgrade journeys remain separate. | Completion of #6 or the fresh-install/upgrade release gate. |

No exploit mechanics, payload shapes, reproduction details, raw configuration or private
endpoints are published in these notes.

## Every issue's current state and justified planned delta

Labels here are the observed set, **not an exact-set mutation instruction**. All open issues
are unassigned, without a milestone and without projectItems. Closed #3/#4 alone have assignee
`Dityath`; no assignment is altered. No implementation Project item will be created.

| Issue / exact title | State / observed labels | Assignee / milestone / project item | Mapped work | Label delta justified? |
| --- | --- | --- | --- | --- |
| #3 Raise verified first-party test coverage to at least 90% | CLOSED; task, area:testing, status:ready | Dityath / none / none | #8 merged | No change; closed historical work |
| #4 [Bug] Canvas toolbar shortcuts, keyboard deletion/undo, and cursor feedback | CLOSED; bug, area:web, area:testing, status:claimed | Dityath / none / none | #5 merged | No change |
| #6 [Feature] Make first-time self-hosting and updates simpler | OPEN; enhancement, area:self-hosting, status:ready | none / none / none | #17–#23 child work | No change; parent gate not complete |
| #9 [Feature] v0.2.0 part 1: make the block documentation editor safe to merge | OPEN; enhancement, area:web, status:ready | none / none / none | Remote editor branch; active local work, no PR | No label change in this PR-based batch; append local/unmerged caveat |
| #10 [Bug] Access guard allows unclassified API routes and nested object routes | OPEN; bug, area:api, status:ready | none / none / none | #26 draft | Yes: ready → claimed, verified active PR |
| #11 [Bug] Placing an entity on a canvas does not check that the actor can read it | OPEN; bug, area:api, status:ready | none / none / none | #27 draft | Yes: ready → claimed; original acceptance/scope untouched |
| #12 [Bug] Canvas events are recorded outside the mutation transaction and undo restores whole metadata | OPEN; bug, area:api, area:data, status:ready | none / none / none | Remote branch; no PR | No label change; preserve independent scope |
| #13 [Bug] Viewers and link guests cannot read connection documentation | OPEN; bug, area:web, status:ready | none / none / none | #25 draft | Yes: ready → claimed |
| #14 [Task] Run browser journeys in CI | OPEN; task, area:testing, status:ready | none / none / none | #29 draft | Yes: ready → claimed; don't duplicate |
| #15 [Task] Add a migration upgrade harness from v0.1.0 | OPEN; task, area:data, area:testing, status:ready | none / none / none | #28 draft | Yes: ready → claimed; don't duplicate |
| #16 [Task] Decide the collaborative document model for v0.2.0 | OPEN; documentation, task, area:api, area:docs, status:ready | none / none / none | Active local ADR/spike; local T1 spike artifact read below, no PR | Yes: ready → claimed for verified local activity, unmerged/pending review, not an accepted model; retain documentation |
| #17 [Bug] Database backups can be copied into the API image | OPEN; bug, area:self-hosting, status:ready | none / none / none | #24 draft | Yes: ready → claimed |
| #18 [Feature] Validate WEB_ORIGIN and runtime configuration at startup | OPEN; enhancement, area:api, area:self-hosting, status:ready | none / none / none | #30 draft, stacked #26 | Yes: ready → claimed |
| #19 [Task] Smoke-test the self-hosted Docker stack in CI | OPEN; task, area:testing, area:self-hosting, status:ready | none / none / none | #31 draft | Yes: ready → claimed |
| #20 [Feature] Publish versioned release images | OPEN; enhancement, area:self-hosting, status:ready | none / none / none | no PR | No change |
| #21 [Feature] Self-hosting access modes with pinned versions and HTTPS | OPEN; enhancement, area:self-hosting, status:ready | none / none / none | no PR | No change |
| #22 [Feature] Self-hosting command for status, diagnosis, backup, restore, and update | OPEN; enhancement, area:self-hosting, status:ready | none / none / none | no PR | No change |
| #23 [Task] Rewrite the self-hosting guide for the supported install path | OPEN; documentation, task, area:docs, area:self-hosting, status:ready | none / none / none | no PR | No change; retain documentation |

Remote editor tip: `1bddbaa200d27da4dd58be4da75f3eabbcd4c51e`; remote #12 branch tip:
`7200a4e1c010d1845eaaa4cd54d5bc1c2c48a424`. Verified with
`git ls-remote origin refs/heads/feat/tiptap-documentation-editor refs/heads/fix/issue-12-canvas-event-integrity`.
Local `git worktree list` additionally showed active documentation-safety work at `687c520`
and access/data-integrity work at `0b8603a`. These local heads are **not remote PR heads** and
must not substitute for remote CI evidence. A missing merged ADR is not grounds to demote an
actively owned decision task to needs-triage; its dependent implementation remains blocked.

## Acceptance → issue → PR → evidence: exact card criteria

Each row quotes one original release-card criterion in full, in the original order; this is
one-to-one criterion coverage, even where several scoped issues implement one criterion.
New slugs below have **no issue numbers yet** and are proposed, not created. Existing issues
cover part of the criterion only where stated. None of these full criteria is established as
merged or released by this audit. Basic fields on main are not proof of the complete journey.

### v0.2.0

| Criterion verbatim | Existing issue / PR | Proposed slugs | Current evidence / gap |
| --- | --- | --- | --- |
| The editor supports paragraph, heading, bullet and numbered list, task list, quote, code block, divider, and table blocks. Typing `/` opens a searchable, keyboard-operable menu and inserts the selected block at the current position. | #9 / no PR | `v0.2/release-evidence` | active unmerged editor branch; slash/safety acceptance still needs integrated review; not merely planned and not a draft PR |
| Importing `.md` or pasting Markdown maps supported constructs to blocks. The import flow previews replacement or insertion, does not silently discard unsupported content, and existing Markdown documentation remains readable and editable after migration. | #9 paste/safety only; #16 representation decision / no PR | `v0.2/markdown-fidelity`, `v0.2/durable-documents` | no issue exists for remaining import/migration journey; decision pending |
| Two permitted editors can type in the same document concurrently without one save replacing the other's work. Reconnect and refresh restore persisted content; an interrupted save or sync has a visible state and recovery path. | #16 decision, #12 event/undo prerequisite / no PR | `v0.2/durable-documents`, `v0.2/sync-access`, `v0.2/coedit-presence`, `v0.2/release-evidence` | decision pending; implementations planned only, no issues yet |
| The document shows the people currently viewing it. Other editors' live carets and selections appear in the document with identifiable names or colors and disappear when they leave. Canvas cursor presence alone does not satisfy this criterion. | #16 / no PR | `v0.2/sync-access`, `v0.2/coedit-presence` | no issue exists for implementation; canvas presence is insufficient |
| Viewers and link-shared guests with access can read but cannot write. Editing, document presence, and updates remain scoped to the entity's workspace and authorized canvas context. | #13/#25 partial reader UI; #10/#26 and #11/#27 prerequisites | `v0.2/sync-access`, `v0.2/coedit-presence`, `shared/multi-canvas-write-rule`, `v0.2/release-evidence` | partial implemented in draft PR (unmerged); new live document matrix not implemented |
| Markdown export or copy produces a useful representation of supported blocks. Round-trip checks cover the documented supported constructs; any unsupported format has a visible, documented limit. | #9 source behavior partial / no PR | `v0.2/markdown-fidelity`, `v0.2/release-evidence` | no issue exists for complete export/round-trip criterion |

**Dependency verbatim:** Choose and test a collaborative document representation and
persistence/recovery model before replacing the current Markdown field. Keep document presence
separate from durable content. Owner #16 (active local decision work, unmerged/pending review);
implementation slugs do not replace it or pre-approve its proposals.

### v0.3.0

| Criterion verbatim | Existing issue / PR | Proposed slugs | Current evidence / gap |
| --- | --- | --- | --- |
| Contracts have an explicit format and are attached to the semantic connection. All connector types can hold and display a contract; the interface does not mislabel a generic or event contract as HTTP. | no feature issue; #10/#26 prerequisite | `v0.3/contract-identity`, `v0.3/contract-authoring` | no issue exists; planned only |
| REST connectors can import OpenAPI JSON, show operations, paths, parameters, request and response shapes, and edit them with clear validation. Editing the visual form does not silently erase source fields it does not expose. The supported OpenAPI version and limits are documented. | no feature issue | `v0.3/openapi-editing` | no issue exists; supported version decision pending |
| Protobuf connectors can import `.proto`, identify package, services, methods, messages, and fields, and offer a useful source and structured reading/editing experience. Local imports/dependencies are resolved or reported clearly; a single unresolved file is not presented as a valid compiled contract. | no feature issue | `v0.3/protobuf-editing` | no issue exists; parser/dependency limits pending |
| A member can create a contract without importing a file, save it, reopen it from another canvas showing the connection, and export its source. Invalid source produces actionable errors and does not replace the last valid saved contract without an explicit choice. | no feature issue | `v0.3/contract-authoring`, `v0.3/contract-identity` | no issue exists; basic contractBody field is not full acceptance |
| Two permitted editors can see who has the contract open and what section or operation the other is viewing or editing. Concurrent changes have a defined merge or conflict flow that avoids silent lost updates; reconnect is recoverable. | #16 reusable transport decision only | `v0.3/contract-sessions` | no issue exists; conflict protocol decision pending, not automatic structured CRDT merge |
| Viewers and link-shared guests see only contracts they may read and cannot edit. Access checks cover the connection's actual registered route and workspace/canvas scope. | #10/#26 prerequisite | `v0.3/contract-access-evidence` | no feature issue; prerequisite draft is not route integration |

**Boundary verbatim:** Kafka, NATS, and other connector types need a usable format-aware source
view and clear type labels in this release. Rich visual editors for event contracts, such as
AsyncAPI channels and messages, can follow after the HTTP and Protobuf journeys are proven.
This does not promise synchronization with external API or schema registries.
Owners `v0.3/contract-identity`, `v0.3/contract-authoring`; no rich AsyncAPI editor/external sync.

### v0.4.0

| Criterion verbatim | Existing issue / PR | Proposed slugs | Current evidence / gap |
| --- | --- | --- | --- |
| Users can add, rename, and remove tables and columns; set common data types, nullability, defaults, primary keys, and foreign keys; and create or change valid relationships through the visual editor. Changes are persisted and survive refresh. | no feature issue | `v0.4/schema-identity-layout`, `v0.4/schema-visual-editing` | no issue exists; current schemaSql is not full criterion |
| Importing the documented PostgreSQL DDL subset produces the same tables and relationships in the diagram. Unsupported statements and unresolved references are reported without silently discarding the source or damaging an existing diagram. | no feature issue | `v0.4/postgresql-import` | no issue exists; supported subset decision pending |
| The saved schema is the source of truth; diagram positions and viewport are stored separately. Moving a table never changes its database definition. Relationship lines identify their source and target columns and remain legible as the diagram grows. | no feature issue | `v0.4/schema-identity-layout`, `v0.4/schema-visual-editing` | no issue exists; separate stable IDs/layout planned |
| The diagram has a name and purpose, can be read without entering edit mode, and shows a usable state for empty, invalid, and larger schemas. At least one export path preserves the supported schema information. | no feature issue | `v0.4/schema-reading-export` | no issue exists; planned only |
| Edits to tables, keys, and relationships validate references and surface conflicts. Viewers and link-shared guests can inspect authorized diagrams but cannot change them. The database entity remains workspace-scoped even when shown on multiple canvases. | #10/#26, #11/#27 prerequisites | `v0.4/schema-visual-editing`, `v0.4/schema-access-evidence`, `shared/multi-canvas-write-rule` | prerequisite draft PRs only; feature integration not implemented |
| If database elements are associated with Protobuf messages or fields, that association is explicit. Generating a service contract from tables is not automatic or required for this release. | no feature issue | `v0.4/schema-identity-layout`, `v0.4/schema-reading-export` | no association promised; explicit stable identity only if associations are implemented; no automatic generation |

### v0.5.0

| Criterion verbatim | Existing issue / PR | Proposed slugs | Current evidence / gap |
| --- | --- | --- | --- |
| Members can create, reply to, resolve, and reopen threads on entities, connections, documentation text, contract operations or sections, and database tables or columns. A comment indicator leads to the exact object or the closest remaining context when its anchor changes. | no feature issue | `v0.5/thread-lifecycle`, `v0.5/object-anchors`, `v0.5/text-anchors` | no issue exists; stable identities and anchor decisions pending |
| Canvas comments use an unobtrusive pin or contextual marker similar to a design review. Text comments stay attached to the selected passage as concurrent edits change nearby content; orphaned anchors are visible and recoverable rather than silently lost. | #16 text model dependency only | `v0.5/object-anchors`, `v0.5/text-anchors` | no implementation issue; depends on v0.2–v0.4 identities |
| `@mention` searches only people eligible for the context. Mentioned people receive a discoverable in-app notification or inbox entry and can open the thread if they still have access. No mention leaks private content to an unauthorized account. | no feature issue | `v0.5/mentions-inbox` | no issue exists; eligibility and inbox planned only |
| Thread authorship, creation and edit time, resolve state, and replies persist. The UI distinguishes open from resolved discussions and lets readers find both without overwhelming the canvas or reading surface. | no feature issue | `v0.5/thread-lifecycle`, `v0.5/object-anchors` | no issue exists; persistence and UI planned only |
| Comment and mention routes enforce the current workspace/canvas/object access rules. Editors and higher roles can comment; viewers and link-shared guests can read authorized threads but cannot write. A guest is never granted write access simply by opening a shared link. | #10/#26 prerequisite only | `v0.5/thread-lifecycle`, `v0.5/mentions-inbox`, `v0.5/comments-access-evidence` | no feature issue; prerequisite draft does not establish new routes |
| Existing documentation, contracts, and schema diagrams remain editable with comments present. Moving or deleting an anchor has a defined outcome tested in the affected editor. | #12 undo prerequisite | `v0.5/object-anchors`, `v0.5/text-anchors`, `v0.5/comments-access-evidence` | no implementation issue; orphan/delete/restore behavior pending |

## Gaps without merged implementation

Every row above is an explicit gap in **full acceptance evidence**: all six criteria per
release v0.2–v0.5 still lack a demonstrated merged, release-ready journey. This does not claim
there is no code at all: main has basic Markdown, contract and schema fields, #9 has an active
block editor branch, and #25 partially implements a reader fix. None is a released co-editor.
All 22 issue bodies below remain proposals until creation; a created issue remains planned
unless implementation starts. Zero issue numbers for these proposals have been invented.

Still missing: v0.2 durable bootstrap/recovery/retention, live sync and revocation, co-editing
carets and undo, Markdown file import/export fidelity, and integrated migration/browser evidence;
v0.3 semantic format/sections, OpenAPI, Protobuf, authoring/export, sessions/conflicts and auth
integration; v0.4 schema IDs/layout, safe DDL import, visual editing, reading/export and conflicts;
v0.5 threads, stable object/text anchors, mentions/inbox and changing-anchor access evidence.

The #16 representation gate awaits reviewed ADR/spike evidence. #12 still owns transaction,
activity and field-aware undo integrity. #14/#15 are the shared browser/upgrade harness owners,
not duplicates of release-specific journeys. #6 and #17–#23 remain the self-hosting chain; even
green #24/#30/#31 checks do not establish #6's complete fresh-host/second-device/update path.

## Release order and shared gates

Order remains v0.2.0 → v0.3.0 → v0.4.0 → v0.5.0 → v0.6.0, with v0.1.0 as baseline.
Dependencies are prerequisites, not proof that a downstream release is active or done.

| Shared owner | Used by | Gate still required |
| --- | --- | --- |
| #10 / #26 | v0.2–v0.5 new object routes/live channels | route classification and fail-closed current access, including recheck findings |
| #11 / #27; separate `shared/multi-canvas-write-rule` | v0.2–v0.4 shared objects | original read-before-placement fix plus separately reviewed cross-canvas write rule |
| #12 | v0.2–v0.5 writes/history/undo | transactional history and feature-owned metadata/delete integration |
| #16 | v0.2 documents; reusable transport for v0.3, text anchors for v0.5 | reviewed representation, spike, persistence/recovery and license evidence |
| #14 / #29 | all v0.2–v0.5 release evidence issues | run combined feature journeys, not just PR-isolated CI |
| #15 / #28 | all v0.2–v0.5 data conversions | extend preserved-content seeds, previous-release cases and deterministic harness |
| #6; #17–#23 (#24/#30/#31 partial) | shared fresh-install/upgrade gate | fresh host, browser/second device, versioned update and restore rehearsal, maintainer review |

### Shared release gate (single reusable verbatim definition)

> Each release is done only when:
>
> - Its user journey works from a fresh self-hosted install and, where applicable, from an upgrade of the previous release without losing existing content.
> - Relevant editors, viewers, workspace roles, and link-shared guests have their intended read/write behavior checked through registered API routes and browser journeys. A revoked user loses access to live sessions.
> - Changed behavior has meaningful automated tests; relevant lint, format, typecheck, build, database integration, and browser checks pass. The maintainer reviews results and remaining limits.
> - UI has usable loading, empty, error, save, and reconnect states, plus keyboard and accessible-label behavior for its primary actions.
> - Documentation, migrations, release notes, upgrade steps, and known limitations reflect what actually shipped. No release tag is created solely to meet a target date.

Source: each live release-card body and [roadmap](roadmap.md). Preserve the existing copy on
every card; do not replace it with a weaker checklist or mark it complete because tooling exists.

## Multi-canvas access decision still open

Origin #11 / PR #27; its accepted read-before-placement scope is unchanged. At requirement level,
read access is sufficient for the placement proposed by that PR, whereas current entity writes
require editor rights across every canvas containing the entity. Fictional example: a member
who reads an entity on “Team A board” and edits “Team B board” may legitimately place it on B,
but an all-canvases write rule can affect source editors on A who were not intended participants
in that action. Neither a shared identity nor a placement should silently imply a new authority.

The new decision issue must ask for a written rule covering that consequence, the permission
matrix, existing placements and compatibility. It does not choose among per-object/per-placement
or higher-placement-authority models. Do not silently redefine #11, publish exploit mechanics,
payloads or reproduction steps, or present this decision as fixed by #27.

## Existing code/contract context and verification profiles

Read before scoping: product, architecture, roadmap, versioning, testing, reporting-issues,
AI-agent guardrails and licensing; revision also read both issue forms, CONTRIBUTING, package
scripts, domain entity/connection types, Zod entity/connection contracts, registered routes and
auth rules. Existing entity metadata holds documentation/schemaSql; connection metadata holds
contract/contractBody/documentation. Those are semantic objects, not XYFlow placement records.
New durable identities must align domain → Zod → migrations → registered API → web consumers.

Current-context permission baseline: authorized link-shared guests and viewers read only;
editors write only where the server's object rule allows; workspace managers and system admins
use their established server-side authority; outsiders and signed-out non-guests are denied.
Main's object write rule requires editor access across relevant placements, pending the separate
decision. Never trust a caller's role, workspace ID or canvas ID. Test wrong-context resources,
revocation, and cross-workspace denial through **registered routes**, not helper tests alone.
Read-only awareness policy (who is visible, not merely who can edit) stays with #16; do not
invent a prohibition on viewer presence when the card requires people currently viewing.

Verify profiles below are **future implementation commands**, not results from this docs task.
Commands/paths were verified in package scripts and CONTRIBUTING. Run in the repository root:

- **Q:** `bun run lint`; `bun run format:check`; `bun run typecheck`; `bun run build`.
- **S:** `bun test packages/*/tests` — extend shared domain/Zod/parser suites.
- **W:** `bun run test:web` — extend tests under apps/web/tests.
- **A:** with DATABASE_URL already set to an isolated, migrated test database,
  `bun test apps/api/tests`; `bun run coverage --enforce`. Never use a database with user data.
- **B:** with BROWSER_TEST_DATABASE_URL set to a separate disposable migrated database,
  `bun run --cwd apps/web test:browser` (Chromium installed); extend apps/web/e2e with the
  explicitly named future journey in each issue. There is no root `bun run test:browser` on main.
- **G:** reuse #14/#15 and the shared release gate: fresh-install + previous-release upgrade,
  retained fictional content, browser and permission matrices, UI/a11y states, docs/release
  notes, maintainer review. These future suites are not yet implemented or passed.

## Authorized GitHub sync plan (planned writes only)

No writes have run. The downstream executor alone may implement the following finite plan.
First re-read current issues/PRs/card bodies and labels. If a head, scope, state or duplicate
changes, stop/reconcile; do not blindly replay this dated snapshot.

### Deduplication and body preservation protocol

For each existing target use exactly one owned appended section:

```markdown
<!-- wooble-release-backlog:tracking:start -->
## Release tracking and evidence
<resolved release links, current work state, dependencies, remote SHA/check evidence,
 supplied local audit note and remaining gates, selected by the target table below>
<!-- wooble-release-backlog:tracking:end -->
```

On first write append this block. On later writes replace **only** the text between the exact
markers. Preserve all original content outside it byte-for-byte, especially unchecked accepted
criteria, reproduction/report context and maintainer notes. Duplicate/malformed markers mean
stop, not truncate. Compare a just-read body/update timestamp against the captured version
before writing; GitHub's edit CLI has no atomic compare-and-swap, so minimize the gap and abort
on conflict. Use JSON input/output and `--body-file`; never interpolate bodies into a shell.

New issues use one persistent identity marker `<!-- wooble-release-backlog:slug=<slug> -->`.
Before create, paginate all open/closed issue bodies (individual `gh issue view` or paginated
API), search the marker and exact title, and reconcile any matching scope. Do not create if it
already exists; record its real number. First create all missing proposals with dependency
slugs, then resolve the slug map to real #numbers/URLs in **only their owned tracking block**.
Keep slugs too, so retries are idempotent. No numbers are preallocated; do not invent branches.

### E — existing issues: edit body and delta labels

| Target | Exact owned-section final content / label operation | Read-back |
| --- | --- | --- |
| #10, #11, #13, #14, #15, #17, #18, #19 | `State: active; PR draft (unmerged), pending maintainer review.` Link the mapped PR using the exact full SHA/table above and correct release association below; append the applicable LOCAL AUDIT note verbatim. For #11 explicitly preserve original read-before-placement scope and link the separate decision without redefining it. Remove only status:ready; add only status:claimed. Preserve all other labels. | `gh issue view <n> --repo Dityath/Wooble --json number,title,body,labels,assignees,milestone,projectItems,updatedAt` |
| #9 | `State: active editor branch/local safety work; no PR, unmerged, pending review. v0.2 criterion 1 and paste/safety part of criterion 2. Remaining collaboration/import/export implementation is linked by slugs; storage unchanged in this increment.` Preserve acceptance; no label change. | same issue read-back |
| #12 | `State: remote branch exists; no PR, unmerged. Shared event/undo prerequisite for v0.2–v0.5. Do not conflate later feature hooks with completion of this scope.` No label change. | same issue read-back |
| #16 | Append `State: active local ADR/spike, unmerged, pending review; not an accepted collaboration model.` Link the observed `docs/spikes/2026-10-13-collaboration-sync.md` artifact, explicitly untracked/local. T1 records seven bounded synthetic transport scenarios passing in three executions; T2 read the report but did not rerun it. Production authentication, persistence, TipTap and browser acceptance remain unproven. Record a full ADR's actual path/SHA/results only after reading it. Remove only status:ready, add only status:claimed; retain documentation, task, area:api, area:docs and all unrelated labels. Recheck the local artifact before execution; if unavailable, leave pending rather than invent evidence. | same issue read-back plus local artifact/SHA read before write |

Associations for the E block: #9/#13/#16 → v0.2; #10/#12/#14/#15 → shared v0.2–v0.5;
#11 → shared multi-canvas v0.2–v0.4; #17/#18/#19 → #6 shared self-hosting gate for v0.2–v0.5.
For all, include `Acceptance remains unchecked until verified; claimed is activity, not approval
or assignment.` No change to #3/#4/#6/#20–#23; their links go on release cards instead.

Label command pattern, **only after active evidence recheck**, never exact-set all labels:
`gh issue edit <n> --repo Dityath/Wooble --remove-label status:ready --add-label status:claimed`.
If ready is already absent and claimed present, skip. Preserve unrelated status changes for
maintainer reconciliation rather than removing labels not authorized here.

### P — existing PR bodies: owned evidence appendix, no state changes

Targets #24–#31, one body edit each. Final owned block is:

```markdown
<!-- wooble-release-backlog:tracking:start -->
## Release tracking and evidence
State: active; PR draft (unmerged), pending maintainer review. Not released or approved.
Issue: <mapped actual issue link>. Release association: <E association above>.
Remote evidence: <exact full current head SHA>; <check names/statuses from that SHA>.
Local audit (supplied, not a remote fix claim): <verbatim applicable audit note above>.
Remaining gates: combined feature integration, applicable role matrix, previous-release
upgrade/fresh install, browser evidence and maintainer review. No checkbox completion inferred.
<!-- wooble-release-backlog:tracking:end -->
```

Resolve these placeholders deterministically from the PR table. #27's audit line is `Separate
multi-canvas write-rule decision remains open; original #11 scope unchanged.` #30 additionally
states `Stacked on #26; base currently fix/issue-10-access-guard-default-deny. Closing reference
is empty while non-default-based; recheck after any retarget/head move.` No review request,
comment, approval, merge, retarget or conversion is authorized. Read-back:
`gh pr view <n> --repo Dityath/Wooble --json number,title,body,headRefOid,baseRefName,isDraft,closingIssuesReferences,statusCheckRollup`.
Use `gh pr edit <n> --repo Dityath/Wooble --body-file <safely-composed-file>` for execution only.

### C — four existing draft release-card bodies and one status change

Preserve user journey, every criterion, dependency/boundary text and the shared gate verbatim.
Append the same owned tracking markers. Use **draft content IDs**, not a new implementation
item. `gh project item-edit --id <DI-content-id> --body <safely-passed-body>` is the draft-body
operation; pass body through a process argument or use a GraphQL JSON variables file, never
shell command interpolation. CLI help must be checked by executor before choosing its route.

| Card | Exact owned-section content to resolve after issue creation |
| --- | --- |
| v0.2, `DI_lAHOA0GxUM4Bk_IkzgLOXXQ` | `State: In Progress; active #9 branch and #13/#25 reader work, no full criteria merged/released. Target October 10 remains revisable, overdue and unchanged.` Link #9/#13/#16; all six v0.2/shared proposal slugs below with resolved issue URLs; #10/#26, #11/#27, #12, #14/#29, #15/#28 and self-hosting #6/#17–#23/#24/#30/#31. Include exact six-row acceptance links from matrix; no completion checkmarks. |
| v0.3, `DI_lAHOA0GxUM4Bk_IkzgLOXYc` | `State: Todo; scoped issues planned, no implementation PR for the contract journey.` Link all six v0.3 slugs by resolved issue URLs, shared owners above, reusable #16/v0.2 transport, and semantic sections needed by v0.5. Link exact six-row coverage and event-source-only boundary. |
| v0.4, `DI_lAHOA0GxUM4Bk_IkzgLOXYk` | `State: Todo; scoped issues planned, no implementation PR for the diagram journey.` Link all five v0.4 slugs, shared owners, separate multi-canvas decision, and stable schema/contract identity dependencies; explicit no automatic service-contract generation. Link exact six-row coverage. |
| v0.5, `DI_lAHOA0GxUM4Bk_IkzgLOXYo` | `State: Todo; scoped issues planned, no implementation PR for contextual comments.` Link all five v0.5 slugs and shared owners; v0.2 document model/Yjs-aware positions, v0.3 stable sections and v0.4 stable table/column IDs. Link exact six-row coverage. |

These are ordinary body links, not an assertion of ProjectV2 relationships. Keep the five
DraftIssues; add **no repository issue/PR Project items**. Do not modify v0.6's content ID.

Only field mutation: `PVTI_lAHOA0GxUM4Bk_Ikzg9Rc_E` Status = In Progress (`47fc9ee4`), using
project `PVT_kwHOA0GxUM4Bk_Ik` and field `PVTSSF_lAHOA0GxUM4Bk_Ikzhjtqzk`:

```sh
gh project item-edit --id PVTI_lAHOA0GxUM4Bk_Ikzg9Rc_E --project-id PVT_kwHOA0GxUM4Bk_Ik --field-id PVTSSF_lAHOA0GxUM4Bk_Ikzhjtqzk --single-select-option-id 47fc9ee4
```

v0.3–v0.5 stay Todo (no field write needed); all dates/titles remain unchanged. v0.6 is not
edited at all. Read-back `gh project item-list 1 --owner Dityath --limit 100 --format json`:
expect totalCount 5, same DraftIssue IDs, preserved original bodies/dates and correct appended
links; only v0.2 Status changed. Compare v0.6 body/status/dates byte-for-byte with pre-write data.

### N — 22 new scoped issues, exact titles and dependencies

Use existing **Feature proposal** (`[Feature]`, enhancement) or **Task** (`[Task]`, task)
categories only. Add existing area labels below plus status:needs-triage to every proposal:
each has an unresolved design or implementation dependency, so none is prematurely ready.
No label/type/project/milestone creation. No monolithic release-task duplicates of #9/#16/#12/#14/#15.
Slug references to `#n` mean existing issues; other slugs resolve after creation.

| Slug | Exact issue title | Category / area labels | Dependencies |
| --- | --- | --- | --- |
| `shared/multi-canvas-write-rule` | [Task] Decide how multi-canvas placement affects entity write access | Task; area:api, area:product | relates #11/#27; no redefinition |
| `v0.2/durable-documents` | [Feature] Persist collaborative documents with safe bootstrap and recovery | Feature; area:api, area:data | #16, #12, #15 |
| `v0.2/sync-access` | [Feature] Authorize document synchronization and legacy writes in the current canvas context | Feature; area:api | #16, #10, #12, v0.2/durable-documents, shared/multi-canvas-write-rule |
| `v0.2/coedit-presence` | [Feature] Co-edit documentation with document presence and recoverable reconnects | Feature; area:web | #9, #16, v0.2/durable-documents, v0.2/sync-access |
| `v0.2/markdown-fidelity` | [Feature] Preview Markdown imports and export supported documentation without silent loss | Feature; area:web | #9, #16, v0.2/durable-documents |
| `v0.2/release-evidence` | [Task] Verify collaborative documentation across users and previous-release upgrades | Task; area:testing, area:docs | #9, #13, #14, #15, v0.2/sync-access, v0.2/coedit-presence, v0.2/markdown-fidelity |
| `v0.3/contract-identity` | [Feature] Give semantic connection contracts explicit formats and stable section identities | Feature; area:api, area:data | #10, #12, #15 |
| `v0.3/openapi-editing` | [Feature] Import and visually edit OpenAPI without erasing unexposed source fields | Feature; area:web | v0.3/contract-identity |
| `v0.3/protobuf-editing` | [Feature] Import and edit Protobuf with clear local dependency diagnostics | Feature; area:web | v0.3/contract-identity |
| `v0.3/contract-authoring` | [Feature] Create and export format-aware contracts while preserving the last valid source | Feature; area:web, area:api | v0.3/contract-identity, v0.3/openapi-editing, v0.3/protobuf-editing |
| `v0.3/contract-sessions` | [Feature] Show contract section presence and recover concurrent editing conflicts | Feature; area:web, area:api | #16, v0.2/sync-access, v0.3/contract-identity, v0.3/contract-authoring |
| `v0.3/contract-access-evidence` | [Task] Verify contract routes and browser journeys against current access rules | Task; area:testing, area:api | #10, #14, #15, v0.3/contract-authoring, v0.3/contract-sessions |
| `v0.4/schema-identity-layout` | [Feature] Persist stable database schema identities separately from diagram layout | Feature; area:api, area:data | #10, #12, #15, shared/multi-canvas-write-rule |
| `v0.4/postgresql-import` | [Feature] Preview PostgreSQL schema imports with unsupported-source diagnostics | Feature; area:web | v0.4/schema-identity-layout |
| `v0.4/schema-visual-editing` | [Feature] Edit tables columns keys and relationships with persisted validation | Feature; area:web, area:api | v0.4/schema-identity-layout |
| `v0.4/schema-reading-export` | [Feature] Read named database diagrams and export their supported schema information | Feature; area:web | v0.4/schema-identity-layout, v0.4/schema-visual-editing, v0.4/postgresql-import; conditional v0.3/contract-identity for explicit associations |
| `v0.4/schema-access-evidence` | [Task] Verify database diagram conflicts permissions and multi-canvas persistence | Task; area:testing, area:api | #10, #11, #14, #15, v0.4/postgresql-import, v0.4/schema-visual-editing, v0.4/schema-reading-export |
| `v0.5/thread-lifecycle` | [Feature] Persist contextual comment threads replies and resolve states | Feature; area:api, area:data | #10, #12, #15 |
| `v0.5/object-anchors` | [Feature] Navigate canvas and model comments with stable object anchors | Feature; area:web | v0.5/thread-lifecycle, v0.3/contract-identity, v0.4/schema-identity-layout |
| `v0.5/text-anchors` | [Feature] Keep documentation comment anchors attached through concurrent edits | Feature; area:web, area:api | #16, v0.2/coedit-presence, v0.5/thread-lifecycle |
| `v0.5/mentions-inbox` | [Feature] Mention eligible teammates with an access-checked in-app inbox | Feature; area:api, area:web | #10, v0.5/thread-lifecycle, v0.5/object-anchors |
| `v0.5/comments-access-evidence` | [Task] Verify comment access and editor behavior when anchors change | Task; area:testing, area:api | #10, #12, #14, #15, v0.5/object-anchors, v0.5/text-anchors, v0.5/mentions-inbox |

The sections below are the **complete proposed body content**, not abbreviations. At creation
wrap them with the identity marker and the existing form headings: Feature uses What happened,
How should it work?, Acceptance criteria, Additional context; Task uses What happened, How to
approach it, Done when, Current evidence. What happened includes the corresponding matrix
criterion(s) and current gap; Outcome → journey/goal, Scope → approach, unchecked Acceptance →
acceptance/done, remaining fields → context/evidence. This is a deterministic format mapping,
not a new category. Do not silently drop any field. Keep dependencies as slugs until their real
numbers are available; then add the resolved map inside the owned tracking block.

### shared/multi-canvas-write-rule — proposed body

**Outcome:** A member placing a readable entity on another fictional team board can understand
whether that action affects source editors, under one written, reviewed access rule.

**Scope:** Product/access decision only. Origin #11/#27; preserve their original read-before-
placement acceptance. No runtime implementation, exploit details or change to #11's scope.

**Acceptance:**
- [ ] Record the chosen rule and its user-visible consequence without choosing it in this proposal.
- [ ] Cover existing placements, source/destination editing rights, revocation and compatibility.
- [ ] Separate scoped implementation follow-ups after approval; no implicit release completion.

**Permissions/API context:** Evaluate guest/viewer read-only, editor on one or multiple boards,
workspace manager, system admin and outsider/signed-out non-guest cases using established
server-validated object/canvas authority. Do not introduce rights via a placement without a rule.

**Migration/data risk:** Document how the decision treats existing multi-canvas placements and
avoids accidental loss of editing authority; no migration in the decision issue itself.

**Verify:** Q for resulting docs; future registered-route permission and multi-canvas regression
suites after the decision (not implemented or run now).

**Dependencies:** relates to #11/#27, not blocked on rewriting them. **Release association:**
v0.2 prerequisite reused by v0.3/v0.4. **Status:** needs-triage; open product decision.

### v0.2/durable-documents — proposed body

**Outcome:** The same entity document survives concurrent first opens, refresh and API restart,
without re-bootstrapping over newer edits or losing original Markdown.

**Scope:** Durable model, bootstrap, persistence/recovery and deletion/undo retention only;
domain/Zod/db/API alignment. Implement the reviewed #16 ADR, not a new representation choice.

**Acceptance:**
- [ ] Workspace/object/field identity addresses one document across all authorized canvases.
- [ ] Server-side first bootstrap is atomic under a lock; preserve original Markdown and hash.
- [ ] Durable state and Markdown mirror recover after interruption; presence is never durable content.
- [ ] Define retention, deletion, workspace cascade and undo restoration with #12 integration.
- [ ] Checked-in migrations preserve existing documents; isolated upgrade and concurrent-bootstrap tests.

**Permissions/API context:** Guests/viewers read only; permitted editors write; managers/admins
follow established authority; outsiders/signed-out non-guests denied. Derive workspace/object
ownership server-side; wrong-canvas/workspace requests cannot bootstrap or inspect another document.

**Migration/data risk:** Highest-risk replacement of Markdown; preserve originals, document
recovery/rollback and retention, never rewrite released migrations or bootstrap from stale clients.

**Verify:** Q, S, A; future durable-document bootstrap/restart/retention tests in apps/api/tests,
and extend #15 upgrade fixtures, not duplicate its harness.

**Dependencies:** #16 approved ADR, #12, #15. **Release association:** v0.2 criteria 2/3,
representation dependency and shared data gate. **Status:** needs-triage; ADR/data dependencies.

### v0.2/sync-access — proposed body

**Outcome:** Only currently authorized peers synchronize an entity document, and legacy writes
cannot silently overwrite concurrent collaborative content.

**Scope:** ADR-approved transport/sync authorization, input validation, revocation, limits and
legacy documentation PATCH compatibility. Separate from durable storage and editor UI.

**Acceptance:**
- [ ] Resolve the object, workspace and authorized canvas context on the registered live route.
- [ ] Read-only peers receive allowed content; mutation attempts cannot alter it; awareness privacy follows #16.
- [ ] Validate/cap updates and sanitize awareness; enforce connection/memory limits and visible recovery.
- [ ] Revocation/recheck errors fail closed before further live data; cover logout and role changes.
- [ ] Legacy replacement requires a base hash; stale replacement returns 409 without losing either draft.
- [ ] Integrate #12's field/history rules; unrelated canvas undo cannot revert collaborative text.

**Permissions/API context:** Test link guest, viewer, editor, manager, admin, outsider and
signed-out non-guest through the real live/legacy routes, including wrong workspace/canvas and
revocation mid-session. Viewer awareness policy is decided by #16, not confused with write access.

**Migration/data risk:** Legacy API clients and limits remain compatible as documented; stale
client data must not replace durable state. Document single-instance/transport limits from ADR.

**Verify:** Q, S, A; future binary sync/access/revocation and stale-base-409 integration suites
under apps/api/tests, later B via v0.2/release-evidence.

**Dependencies:** #16, #10, #12, v0.2/durable-documents, shared/multi-canvas-write-rule.
**Release association:** v0.2 criteria 3/4/5. **Status:** needs-triage; transport/access dependencies.

### v0.2/coedit-presence — proposed body

**Outcome:** Two permitted editors co-edit the same documentation, see document viewers and
identifiable carets/selections, and recover from disconnect without a lost-save overwrite.

**Scope:** TipTap integration with ADR-approved sync; not #9's existing slash-menu/safety fixes.
Document presence distinct from canvas cursors; read-only UI and schema-version compatibility.

**Acceptance:**
- [ ] Concurrent editing converges; refresh/reconnect restores content and pending work visibly.
- [ ] Show permitted current viewers and editor carets/selections; remove stale presence on leave.
- [ ] Use Yjs-aware undo if adopted by ADR; disable competing StarterKit undoRedo in that mode.
- [ ] Schema drift/stale client versions do not discard unknown content; show a safe recovery state.
- [ ] Read-only/revoked peers cannot submit changes; loading/save/error/reconnect states are accessible.

**Permissions/API context:** Guests/viewers read, not edit; editors write only when current object
rule permits; managers/admins retain authority; outsiders/signed-out non-guests denied. Recheck
the authorized workspace/canvas session instead of trusting cached client roles.

**Migration/data risk:** No browser-only JSON becomes unreviewed durable authority; preserve
unsupported content and unsent drafts during version/reconnect changes, respecting revoked access.

**Verify:** Q, W, B; future two-browser document co-edit, caret/leave, undo, reconnect and
schema-drift journeys, integrated with A evidence from sync issue.

**Dependencies:** #9, #16, v0.2/durable-documents, v0.2/sync-access.
**Release association:** v0.2 criteria 3/4/5. **Status:** needs-triage; approved sync pending.

### v0.2/markdown-fidelity — proposed body

**Outcome:** A member previews insertion/replacement from a Markdown file and exports or copies
useful Markdown without silently losing supported or unsupported content.

**Scope:** File import preview plus paste/export fidelity and supported-construct documentation;
reuse #9's safe editor. Preserve unsupported originals; do not decide representation independently.

**Acceptance:**
- [ ] File import/paste maps supported constructs and previews replacement or insertion explicitly.
- [ ] Unsupported constructs remain recoverable with visible warnings/source fallback, never silent loss.
- [ ] Export/copy and round-trip fixtures cover all documented block constructs including tables.
- [ ] Existing Markdown remains readable/editable after migration; import failure leaves saved content intact.
- [ ] Keyboard-operable confirmation, loading, empty/error states and documented unsupported limits.

**Permissions/API context:** Guests/viewers may read/copy/export allowed content, never import or
save; permitted editors and managers/admins may import; outsiders denied. Any import save uses
authorized workspace/object/canvas routes, not an unchecked client conversion bypass.

**Migration/data risk:** Preserve original Markdown and formatting limits; do not replace a
document until confirmed, validated and authorized; extend durable-model migration fixtures.

**Verify:** Q, S, W, B; future supported/unsupported Markdown fixtures, preview/cancel, migration
readability and export round-trip browser journey.

**Dependencies:** #9, #16, v0.2/durable-documents. **Release association:** v0.2 criteria 2/6.
**Status:** needs-triage; representation/fidelity dependencies.

### v0.2/release-evidence — proposed body

**Outcome:** A maintainer can inspect complete collaborative-document evidence on the combined
candidate, not infer release readiness from independent green foundation PRs.

**Scope:** Release-specific multi-user/browser/migration fixtures and reports, using #14/#15
existing harnesses. Do not create another CI or upgrade-harness task.

**Acceptance:**
- [ ] Exercise all six card criteria on one combined candidate SHA, including #9/#13 integration.
- [ ] Concurrent users, refresh/reconnect, interruption, revocation, schema drift and Markdown fidelity tested.
- [ ] Upgrade fictional existing Markdown without loss and show original/mirror/retention evidence.
- [ ] Fresh-install and previous-release paths, UI/a11y states, docs and known limits reviewed; no tag solely for date.
- [ ] Record commands, SHAs, actual results and unproven limits; no pre-checked acceptance boxes.

**Permissions/API context:** Browser and registered API journeys cover guest/viewer read-only,
editor, manager, admin and outsider/signed-out non-guest, wrong-context objects and live revocation.

**Migration/data risk:** Disposable databases only; preserve prior content and collect evidence
before cleanup. Reuse #15 and resolve its deterministic/pre-drop finding rather than assume fixed.

**Verify:** Q, S, W, A, B, G; future apps/web/e2e collaborative-document release suite and #15
upgrade seed extensions. #6/self-hosting checklist remains a maintainer gate.

**Dependencies:** #9, #13, #14, #15, v0.2/sync-access, v0.2/coedit-presence,
v0.2/markdown-fidelity. **Release association:** v0.2 all criteria/shared gate.
**Status:** needs-triage; candidate not implemented.

### v0.3/contract-identity — proposed body

**Outcome:** One semantic connection carries a correctly labelled contract format and stable
section/operation identities wherever it is displayed.

**Scope:** Domain/Zod/storage/registered API representation and identity mapping; explicit
format independent of connector label. Preserve legacy contract fields; no parser/visual-editor duplication.

**Acceptance:**
- [ ] All connector types hold/display an explicit format without treating generic/event source as HTTP.
- [ ] Contract ownership stays with connection/workspace, not a canvas placement; reopen from another canvas.
- [ ] Stable section/operation IDs survive supported edits and have defined delete/recreate behavior.
- [ ] Versioned contract validation and migration preserve legacy source and unrelated metadata.
- [ ] Document source-only event contract boundary and stable-anchor limits for future comments.

**Permissions/API context:** Guest/viewer read allowed connection only; editor writes under current
object rule; manager/admin authority retained; outsider/signed-out non-guest denied. Registered
connection routes and any nested routes validate workspace and canvas context via #10.

**Migration/data risk:** Legacy contract/contractBody must not be guessed destructively into a
format; preserve source and stable IDs, extend #15 migration cases and #12 history integration.

**Verify:** Q, S, A; future contract-format/identity route tests and legacy migration fixtures.

**Dependencies:** #10, #12, #15. **Release association:** v0.3 criteria 1/4 and event boundary;
v0.5 anchors reuse IDs. **Status:** needs-triage; representation/identity choices pending.

### v0.3/openapi-editing — proposed body

**Outcome:** A member imports supported OpenAPI JSON, understands operations and edits a visual
form without losing fields the visual editor does not expose.

**Scope:** OpenAPI import/validation and source-preserving visual/source editing; choose/document
the supported version and limits before implementation. No external API/registry synchronization.

**Acceptance:**
- [ ] Supported version/limits explicit; parse failures and unsupported features produce actionable diagnostics.
- [ ] Display/edit operations, paths, parameters and request/response shapes with stable section IDs.
- [ ] Visual edits retain unknown/unexposed fields and original source on validation/import failure.
- [ ] Source/visual switches and reimport do not silently erase data; expose validation/read-only states.

**Permissions/API context:** Guests/viewers inspect only authorized contracts; editor and
manager/admin save via current connection workspace/canvas rules; outsiders denied. Parsing a
file does not grant API write permission; registered save routes enforce it.

**Migration/data risk:** Preserve imported JSON/source extensions and last valid representation;
no lossy rewrite of legacy contractBody. Unsupported versions never masquerade as validated.

**Verify:** Q, S, W, B; future OpenAPI version/extension fixtures and source-preserving visual
edit browser journey; A registered save checks coordinated with authoring/access issue.

**Dependencies:** v0.3/contract-identity. **Release association:** v0.3 criterion 2.
**Status:** needs-triage; version/support and identity dependency.

### v0.3/protobuf-editing — proposed body

**Outcome:** A member imports/edits Protobuf and sees packages, services, methods, messages and
fields with truthful local-import diagnostics.

**Scope:** Source plus structured reading/editing, parser choice and documented supported syntax;
local dependency handling only, no remote registry synchronization or generated service promises.

**Acceptance:**
- [ ] Show package/services/methods/messages/fields and preserve source through supported edits.
- [ ] Resolve supplied local imports or clearly identify unresolved references and dependencies.
- [ ] Never present one unresolved file as a valid compiled contract; actionable errors retain last source.
- [ ] Stable section identities and documented parser/version/size limits; keyboard/read-only states.

**Permissions/API context:** Authorized guests/viewers read; permitted editors plus managers/admins
save under server-validated connection/workspace/canvas access; outsiders denied. Import diagnostics
must not retrieve private source or allow cross-context reads through user-supplied references.

**Migration/data risk:** Preserve .proto source, comments/unknown constructs and unresolved originals;
no destructive replacement merely because a parser cannot compile it.

**Verify:** Q, S, W, B; future Protobuf fixtures for services/messages/local imports/missing
dependencies and source editing browser journey; registered persistence tests in A.

**Dependencies:** v0.3/contract-identity. **Release association:** v0.3 criterion 3.
**Status:** needs-triage; parser/support and identity dependency.

### v0.3/contract-authoring — proposed body

**Outcome:** A member creates a contract without a file, saves it, reopens it on another canvas
and exports source, with invalid drafts unable to silently replace the last valid contract.

**Scope:** Format-aware authoring/save/export workflow and API validation. Event/generic
contracts receive labelled source views only; no rich AsyncAPI editor or external sync.

**Acceptance:**
- [ ] Create without import, save and reopen the same semantic contract from another authorized canvas.
- [ ] Export source in the declared format; Kafka/NATS/other source views have accurate labels.
- [ ] Invalid draft has actionable errors and preserves last valid saved content unless explicitly chosen.
- [ ] Loading/empty/save/failure/read-only states retain recoverable local work with no unauthorized restoration.

**Permissions/API context:** Guests/viewers read/export allowed contracts, not save; editors follow
object-write rule, managers/admins retain authority, outsiders denied. Registered saves resolve
connection/workspace/context on server, never trust client roles or cached UI rights.

**Migration/data risk:** Separate recoverable drafts from valid durable source; preserve legacy
fields and source not understood by visual editors; document any explicit invalid-save choice.

**Verify:** Q, S, W, A, B; future create/reopen/export/last-valid contract suites, no passing
claim from current basic fields.

**Dependencies:** v0.3/contract-identity, v0.3/openapi-editing, v0.3/protobuf-editing.
**Release association:** v0.3 criteria 1/4 and event-source boundary.
**Status:** needs-triage; formats and validation dependencies.

### v0.3/contract-sessions — proposed body

**Outcome:** Permitted collaborators see who has a contract open and which section is active,
with an explicit recoverable conflict flow rather than silent lost updates.

**Scope:** Stable-section presence, conflict/version protocol and reconnect. Reuse reviewed
transport/access concepts; **do not assume automatic CRDT merging of structured contracts**.

**Acceptance:**
- [ ] Viewer list and section/operation presence are identifiable and disappear on leave.
- [ ] Choose/document merge-or-conflict behavior; stale saves never silently overwrite newer source.
- [ ] Conflict retains both useful drafts; reconnect restores persisted state and exposes recovery.
- [ ] Section rename/delete and incompatible schema versions have defined presence/conflict outcomes.

**Permissions/API context:** Guests/viewers read only with ADR-approved awareness privacy;
editor/manager/admin mutations authorized for current connection/canvas/workspace; outsiders denied.
Revocation/recheck failure closes access and does not broadcast private section names.

**Migration/data risk:** Preserve versioned valid source/drafts; transient awareness separate from
durable state; no implicit destructive structured merge.

**Verify:** Q, W, A, B; future two-member contract conflict/reconnect/section-presence tests.

**Dependencies:** #16, v0.2/sync-access, v0.3/contract-identity, v0.3/contract-authoring.
**Release association:** v0.3 criterion 5. **Status:** needs-triage; conflict model not decided.

### v0.3/contract-access-evidence — proposed body

**Outcome:** Registered contract routes and complete browser journeys enforce current connection
authority and prove no source is leaked or edited outside it.

**Scope:** Integrate feature authorization, regression suites, combined browser and migration
evidence; reuse #14/#15 rather than create another harness task.

**Acceptance:**
- [ ] Real registered read/save/import/export/presence routes enforce workspace/canvas/object scope.
- [ ] Wrong context, guest mutation, outsider and revoked-session paths are covered without content leakage.
- [ ] Combined OpenAPI/Protobuf/event-source journeys, conflict recovery and a11y/UI states pass on candidate SHA.
- [ ] Extend upgrade seed for legacy contracts/stable sections; document supported limits and shared gates.

**Permissions/API context:** Full guest/viewer/editor/manager/admin/outsider/signed-out non-guest
matrix through registered routes and browsers; revocation during open contract sessions tested.

**Migration/data risk:** Disposable fixtures; inspect preserved legacy source/IDs before cleanup;
previous-release upgrade evidence is required, not implied by a parser test.

**Verify:** Q, S, W, A, B, G; future contract-route matrix and combined apps/web/e2e release
journeys plus #15 upgrade cases. #6 remains a shared maintainer gate.

**Dependencies:** #10, #14, #15, v0.3/contract-authoring, v0.3/contract-sessions.
**Release association:** v0.3 criterion 6 and shared gate. **Status:** needs-triage; feature dependencies.

### v0.4/schema-identity-layout — proposed body

**Outcome:** One database entity owns a persisted schema with stable table/column/key IDs, while
positions and viewport remain independent presentation data.

**Scope:** Domain/Zod/storage/API schema identity and separate layout; preserve existing schemaSql.
Prepare stable targets for comments; no automatic database-to-service contract generation.

**Acceptance:**
- [ ] Stable table/column/key/relationship identity survives rename and authorized multi-canvas reopen.
- [ ] Layout/viewport stored separately; moving a table never changes its schema definition.
- [ ] Versioned schema and migration preserve old SQL and unrelated metadata; delete/restore IDs defined.
- [ ] If associations to Protobuf are supported, they use explicit stable references, never inferred generation.

**Permissions/API context:** Guests/viewers inspect allowed schema/layout only; editors under
entity-write rule and managers/admins edit; outsiders denied. Entity/workspace and authorized
canvas context checked at registered schema/layout routes, with separate decision respected.

**Migration/data risk:** Preserve legacy SQL during adoption; stable IDs must not regenerate on
refresh or layout moves; extend #15 and integrate #12 history/undo without whole-metadata loss.

**Verify:** Q, S, A; future schema-ID/layout separation, rename/delete/restore and migration tests.

**Dependencies:** #10, #12, #15, shared/multi-canvas-write-rule.
**Release association:** v0.4 criteria 1/3/6; v0.5 schema anchors.
**Status:** needs-triage; representation/layout ownership dependencies.

### v0.4/postgresql-import — proposed body

**Outcome:** A member previews a PostgreSQL DDL import and sees supported tables/relationships
and honest diagnostics without losing original source or damaging an existing diagram.

**Scope:** Documented DDL subset/parser, preview/confirm, unsupported/unresolved diagnostics.
Parsing only: never execute imported SQL against an operator database.

**Acceptance:**
- [ ] Supported PostgreSQL DDL subset/version/limits documented with fixtures.
- [ ] Preview tables/columns/keys/relationships and report unsupported statements/unresolved references.
- [ ] Cancel/failed/partial import preserves original SQL and existing diagram; confirm required.
- [ ] Supported import assigns stable IDs with an explicit mapping/replacement rule, not silent anchor loss.

**Permissions/API context:** Guest/viewer reading only; permitted editors and managers/admins
import via authorized entity/workspace/canvas API; outsiders denied. Client preview is not
server permission and source diagnostics cannot expose other workspace data.

**Migration/data risk:** Preserve unsupported SQL/source; no execution, destructive overwrite or
unannounced re-ID of an existing schema; historical schemaSql remains recoverable.

**Verify:** Q, S, W, A, B; future DDL subset/unsupported/reference fixtures and import preview
browser journey, with migrated legacy source checks.

**Dependencies:** v0.4/schema-identity-layout. **Release association:** v0.4 criterion 2.
**Status:** needs-triage; supported subset and ID mapping pending.

### v0.4/schema-visual-editing — proposed body

**Outcome:** A member visually edits tables/columns/keys and valid relationships, then refreshes
to find the same validated schema with legible source/target relationship lines.

**Scope:** Visual CRUD, common types/nullability/defaults/primary and foreign keys, reference
validation and versioned save conflicts. Not schema identity or importer duplication.

**Acceptance:**
- [ ] Add/rename/remove tables and columns; edit documented types, nullability and defaults.
- [ ] Add/change valid keys and relationships with visible source/target columns and readable lines.
- [ ] Validate references; dangling/deleted targets are reported before destructive saves.
- [ ] Persist across refresh; stale concurrent edits surface recoverable conflicts, never silent overwrite.
- [ ] Keyboard/actions/loading/empty/error/save states remain usable for larger schemas.

**Permissions/API context:** Guest/viewer read-only; editor under entity/object rules and
manager/admin edit; outsiders denied. Every save verifies current entity/workspace/canvas scope
at registered API, including multi-canvas constraints and revoked permission.

**Migration/data risk:** Stable IDs survive rename; removal explicitly handles dependent keys
and future anchors; layout moves do not mutate durable schema, undo coordinated with #12.

**Verify:** Q, S, W, A, B; future visual CRUD/reference/conflict suites and larger-schema browser journey.

**Dependencies:** v0.4/schema-identity-layout. **Release association:** v0.4 criteria 1/3/5.
**Status:** needs-triage; identity and conflict protocol dependencies.

### v0.4/schema-reading-export — proposed body

**Outcome:** A reader opens a named diagram with a purpose without edit mode and exports supported
schema information without loss.

**Scope:** Title/purpose/read-only surface, empty/invalid/larger states and one documented export.
Any Protobuf association is explicit by stable IDs; no service contract generator is included.

**Acceptance:**
- [ ] Diagram name/purpose persisted and readable; empty/invalid/larger schema states usable.
- [ ] A documented export preserves supported columns/types/defaults/keys/relationships.
- [ ] Explicitly label any optional Protobuf associations; do not infer or generate contracts from tables.
- [ ] Export handles unsupported source visibly; read surface and keyboard actions do not change schema.

**Permissions/API context:** Guest/viewer can read/export only permitted diagrams; editor and
manager/admin edit title/purpose through current entity/workspace/canvas API rules; outsiders denied.
Read-only mode must not expose hidden contract/schema association content.

**Migration/data risk:** Titles/purpose and exports preserve existing schema source; association
references, if implemented, use stable identities and handle removed targets explicitly.

**Verify:** Q, S, W, A, B; future reading/large-state and export fidelity tests; verify optional
association visibility through registered APIs, not automatic-generation tests.

**Dependencies:** v0.4/schema-identity-layout, v0.4/schema-visual-editing,
v0.4/postgresql-import; conditional v0.3/contract-identity if associations are implemented.
**Release association:** v0.4 criteria 4/6. **Status:** needs-triage; schema/export dependencies.

### v0.4/schema-access-evidence — proposed body

**Outcome:** A maintainer can inspect proof that diagrams persist on multiple canvases, reject
unauthorized changes and surface conflicts without damaging earlier schema information.

**Scope:** Registered API authorization/conflict integration and combined release browser/data
fixtures; reuse #14/#15 instead of duplicating harnesses.

**Acceptance:**
- [ ] Same entity schema survives refresh/multi-canvas reopen; layout and schema remain separate.
- [ ] Permission and wrong-context/conflict cases exercise actual registered schema/layout routes.
- [ ] Import/edit/read/export combined journey and larger-schema keyboard/UI states tested.
- [ ] Preserve schemaSql/IDs through previous-release upgrade; report limits and shared gate evidence.

**Permissions/API context:** Guests/viewers read, never mutate; editors allowed only by current
object rule, managers/admins authorized, outsiders/signed-out non-guests denied; revoked sessions
cannot keep saving and cross-workspace IDs do not expose content.

**Migration/data risk:** Disposable databases; original SQL and stable IDs checked before cleanup;
import failure/conflict must not replace existing schema or later collaborator edits.

**Verify:** Q, S, W, A, B, G; future diagram route matrix/conflict/multi-canvas browser suites
and #15 upgrade fixtures. Shared #6 self-hosting gate remains separate.

**Dependencies:** #10, #11, #14, #15, v0.4/postgresql-import, v0.4/schema-visual-editing,
v0.4/schema-reading-export. **Release association:** v0.4 criterion 5/shared gate.
**Status:** needs-triage; feature dependencies.

### v0.5/thread-lifecycle — proposed body

**Outcome:** Permitted members create/reply/resolve/reopen contextual threads with persisted
authorship, creation/edit times and replies; readers can distinguish open and resolved threads.

**Scope:** Thread/reply/state domain contracts, migrations and registered routes; typed context
references. UI anchoring and mentions are separate scoped work, not hidden deliverables here.

**Acceptance:**
- [ ] Create/reply/resolve/reopen routes persist thread/reply authorship/times and state.
- [ ] Typed entity/connection/canvas/document/contract/schema context has validated ownership.
- [ ] Reader listing exposes open and resolved threads without hidden history or unauthorized context.
- [ ] Delete/restore retention and concurrent reply/state transitions defined with #12 integration.

**Permissions/API context:** Guests/viewers read allowed threads only, not comment/resolve/reply;
editor/higher roles (manager/admin) follow current object/canvas rules; outsiders denied. Thread
ID alone never bypasses workspace/context access; signed-out non-guests cannot read private threads.

**Migration/data risk:** New tables/foreign keys/retention; preserve authorship/history and
handle deleted contexts deliberately, never cascade away recoverable discussion silently.

**Verify:** Q, S, A; future thread/reply/state registered-route matrix, concurrent transition
and migration/retention tests under apps/api/tests.

**Dependencies:** #10, #12, #15. **Release association:** v0.5 criteria 1/4/5.
**Status:** needs-triage; context/retention design dependencies.

### v0.5/object-anchors — proposed body

**Outcome:** A contextual marker takes a reader to the entity, connection, canvas placement,
contract section or schema table/column they discussed, or to an explicit remaining context.

**Scope:** Typed stable-ID anchors, unobtrusive canvas pins, detail indicators and thread list
navigation; document-text anchor movement is separate. Preserve semantic vs placement ownership.

**Acceptance:**
- [ ] Entity/connection and optional canvas-placement anchors use the correct stable context.
- [ ] Contract operation/section and database table/column anchors use upstream stable IDs.
- [ ] Indicators lead to exact or closest remaining context; deleted/moved anchors are visibly orphaned.
- [ ] Open/resolved discovery, resolve/reopen UI and keyboard actions do not overwhelm reading/canvas.

**Permissions/API context:** Guests/viewers navigate/read allowed threads only; editor and
manager/admin comment under context rules; outsiders denied. Registered anchor resolution
checks current workspace/canvas/object access before revealing target labels or content.

**Migration/data risk:** Rename/move must not change stable IDs; define delete/recreate/undo
anchor mapping and distinguish canvas placement discussion from global object discussion.

**Verify:** Q, S, W, A, B; future canvas/entity/connection/contract/schema anchor navigation,
orphan recovery and open/resolved browser tests.

**Dependencies:** v0.5/thread-lifecycle, v0.3/contract-identity, v0.4/schema-identity-layout.
**Release association:** v0.5 criteria 1/2/4/6. **Status:** needs-triage; stable IDs pending.

### v0.5/text-anchors — proposed body

**Outcome:** A comment on selected documentation text stays attached during permitted concurrent
edits; an orphan remains visible and recoverable rather than disappearing.

**Scope:** ADR-compatible collaborative text positions (Y.RelativePosition if Yjs is approved),
selection/anchor resolution and orphan recovery. No competing durable document model.

**Acceptance:**
- [ ] Selected passage uses stable collaborative positions, not brittle character offsets alone.
- [ ] Concurrent nearby editing and reconnect preserve the intended passage/context.
- [ ] Deletion/schema drift creates a visible recoverable orphan with a defined reattach outcome.
- [ ] Comments never prevent normal editing or cause canvas undo to revert collaborative text.

**Permissions/API context:** Guests/viewers read allowed anchors/threads, not create/reattach;
editor/manager/admin may comment under current entity/workspace/canvas rules; outsiders denied.
Registered thread/document routes recheck access, including revocation and no private excerpt leaks.

**Migration/data risk:** Position encoding tied to reviewed #16 document model/version; preserve
anchor data through migration/delete/restore and never silently rewrite text to repair an anchor.

**Verify:** Q, S, W, A, B; future concurrent text-anchor movement/deletion/reattach/reconnect
fixtures and apps/web/e2e journey, including normal editor operation with comments.

**Dependencies:** #16, v0.2/coedit-presence, v0.5/thread-lifecycle.
**Release association:** v0.5 criteria 1/2/6. **Status:** needs-triage; collaborative positions pending.

### v0.5/mentions-inbox — proposed body

**Outcome:** A permitted member finds only context-eligible teammates to mention; recipients
discover the discussion in-app and can open it only while still authorized.

**Scope:** Eligibility lookup, mention storage and minimal in-app inbox/notification; no email
delivery, private endpoint disclosure or external integration promises.

**Acceptance:**
- [ ] Search returns only eligible people for the current context; no hidden member/content disclosure.
- [ ] A valid mention creates a discoverable inbox entry linked to the thread.
- [ ] Recheck eligibility at creation, delivery/read and navigation; revocation removes content access.
- [ ] Unauthorized mentions cannot create notifications containing private text/labels; safe empty/error UI.

**Permissions/API context:** Guests/viewers may read eligible authorized thread content but cannot
create mentions; editor/manager/admin may mention only current eligible recipients; outsiders denied.
Inbox is recipient-scoped and all registered search/mention/thread routes validate workspace/canvas/object.

**Migration/data risk:** New recipient-linked records/retention; avoid storing or returning
private previews after access is lost, and avoid duplicate notifications on retried writes.

**Verify:** Q, S, W, A, B; future eligible-member search, denied mention, retry/delivery,
recipient-only inbox and revoked recipient browser/route tests.

**Dependencies:** #10, v0.5/thread-lifecycle, v0.5/object-anchors.
**Release association:** v0.5 criteria 3/5. **Status:** needs-triage; context/inbox design pending.

### v0.5/comments-access-evidence — proposed body

**Outcome:** A maintainer sees proof that contextual comments remain usable and private while
documentation, contracts, tables and canvas placements are edited, moved or deleted.

**Scope:** Combined editor/anchor authorization and lifecycle regression coverage, using
#14/#15 harnesses. Do not duplicate thread/mention/anchor implementations.

**Acceptance:**
- [ ] Registered comment/reply/resolve/mention/inbox/anchor routes enforce current context rules.
- [ ] Guest/viewer cannot gain write through a link; revoked/outsider requests leak no thread/excerpt.
- [ ] Move/delete/restore contract/schema/object anchors and concurrent text edits have visible defined outcomes.
- [ ] Existing editors remain editable with comments; open/resolved discovery and keyboard/narrow-layout journeys tested.
- [ ] Migrations preserve thread authorship/times/replies/state/anchors; publish real shared-gate limits.

**Permissions/API context:** Guest/viewer read-only; editor/higher manager/admin comment as
authorized; outsiders/signed-out non-guests denied. Registered routes and browser sessions test
wrong workspace/canvas/object, eligibility changes and revoked recipients/live peers.

**Migration/data risk:** Disposable previous-release upgrades, explicit orphan/delete/retention
checks and evidence before cleanup; no destructive production fixtures or automatic reassignment.

**Verify:** Q, S, W, A, B, G; future combined comment/mention/changing-anchor release journey
and #15 migration fixtures; #6 fresh-host/upgrade gate still needs maintainer evidence.

**Dependencies:** #10, #12, #14, #15, v0.5/object-anchors, v0.5/text-anchors,
v0.5/mentions-inbox. **Release association:** v0.5 criteria 5/6/shared gate.
**Status:** needs-triage; upstream editor and anchor implementations pending.

### Execution order, read-back and write log

1. Re-snapshot PR/issue/card state and preserve all originals locally (no sensitive bodies in logs).
2. Deduplicate the 22 proposals by slug/title against all open/closed issues, then create only missing
   proposals with table labels and complete bodies. Log actual returned URLs/numbers, not estimates.
3. Resolve every new-slug dependency to that map, using read-before-write owned block updates.
4. Update E/P blocks and authorized delta labels, rechecking #16's observed local artifact first.
5. Append four C card blocks, then set only v0.2 Status. Verify exactly five draft items and unchanged v0.6.

Creation uses `gh issue create --repo Dityath/Wooble --title <exact-title> --body-file <body-file>`
plus separate `--label` arguments from its row and `status:needs-triage`. Read-back for each:
`gh issue view <actual-number> --repo Dityath/Wooble --json number,title,body,labels,assignees,milestone,projectItems,updatedAt`.
Expect identity slug, every required body field, unchecked acceptance, correct labels and
resolved dependencies; no new assignee/milestone/projectItems. Existing unrelated labels survive.

Log schema for downstream executor (no writes logged as done by this task):

| Operation key | Target / slug | Before updatedAt/body fingerprint/labels | Planned delta | Actual URL / SHA | Read-back result | State |
| --- | --- | --- | --- | --- | --- | --- |
| E / P / C / N | fill with actual target | capture just before write | only authorized body block/label/Status | record actual GitHub return | compare preserved outside text and final owned block | pending until verified |

On retry, skip equal blocks/labels/status and existing slug matches. If a read-back fails,
stop and report; do not compensate by closing/deleting/recreating. Document #16 pending rather
than invent evidence. Read-back commands are checks, not claims that this task executed writes.

### Explicitly out of authorization

No merges, closes/reopens, retargets, branch pushes, commits, review requests/approvals,
comments, notifications/mentions, assignee or milestone creation/changes, new labels/categories,
branch-protection/default-branch/visibility changes, release tags/dates, deletions, Project
implementation items or replacement of the five cards. No edit of v0.6. No change to accepted
#11 scope, original unchecked acceptance or unrelated body text/labels. No automatic contract
generation, external registry sync, or collaboration model decision by this document.

## Interim editor ADR — read off main

Read using `git show 997c8224783dbe32009a0f982624cdd310f677f1:docs/decisions/documentation-storage.md`.
This file is from the editor branch, **not main**; `git ls-tree -r
4b5fa0a73baba300004da5caf661080c8750e4ab -- docs/decisions` returned no paths. No merge or copy.

Actual interim decision: retain Markdown storage/API; TipTap/ProseMirror JSON is temporary
browser state, saves remain last-write-wins, not collaborative. Opening/focusing/moving the
caret must not normalize/save; only real edits write. Supported Markdown may normalize;
compact tables/plain URLs prevent artificial growth. Unsupported images, footnotes, YAML front
matter and raw HTML use source editing with warnings, not lossy conversion. No field/migration
change. It defers representation/sync/persistence/access/history/migration decisions and realistic
Yjs recovery tests; if adopting collaboration, use Yjs-aware undo instead of competing StarterKit
undoRedo and reconcile document history with canvas activity/undo before replacing storage.

#16 asks for the larger collaboration-sync ADR/spike, including reviewed transport, persistence,
limits, retention, legacy base-hash compatibility and reusable positions. Its local work is
active and may be claimed while unmerged; approval is still pending. At the initial revision
file search, `collaboration-sync.md` was not yet visible. During verification, another agent's
`docs/spikes/2026-10-13-collaboration-sync.md` appeared and was read; it is untracked/local,
not a merged ADR. It establishes observable task activity without inventing a human assignee.

**Local spike evidence, attributed to T1:** the report records Bun 1.3.14, Elysia 1.4.30,
Yjs 13.6.33, y-protocols 1.0.7 and lib0 0.2.119, with direct MIT license checks. It reports
seven bounded scenarios passing in three actual executions: binary editor exchange, late join,
synthetic reader enforcement, concurrent disconnected edits, another reconnect, sanitized
presence/removal and bounded malformed-input rejection. T2 read the report; **T2 did not execute
the spike or independently certify those results**. The report explicitly excludes real
authentication/authorization, durable persistence/crash recovery, TipTap rich-text integration,
browser journeys, multi-instance/load guarantees and exhaustive hostile-input resilience.
These boundaries belong in #16's tracking block. A full local ADR may subsequently appear;
read its actual artifact/SHA rather than fabricate a completion or merge claim.

## v0.6 historical coverage note (not an authorized edit)

The initial snapshot recorded future feedback triage, bounded blocker fixes, consistent journeys
and install/upgrade validation as planned roadmap work, with no dedicated feature issues. This
revision creates none and makes no judgment that triage has happened. The existing v0.6 draft
card, dates and status are left completely untouched; its roadmap criteria remain authoritative.

## Limits of this snapshot

- Live GitHub and local audit are different evidence sources. Supplied local findings were not
  independently re-run here; author-reported checks/reviews are not approvals or remote fixes.
- If a head/base moves, re-fetch check `head_sha` and PR mapping; missing required runs become
  UNKNOWN. SHA-specific success still does not establish integrated release coverage.
- #30's non-default base explains its empty closing array now, not after a future retarget.
- No future feature suite, disposable database, browser, Docker, spike or deployment journey
  was run by this docs task. Verify profiles specify future work only. Docs lint/format checks
  are reported in the task handoff, not turned into feature evidence.
- #16's local artifact/results need the other agent and maintainer review. This task scopes
  dependent proposals but does not accept a representation or change persisted code.
- Card links are body prose links. They do not create Project implementation items or native
  issue/card relations; maintain them with marker-aware sync rather than claim linkage is impossible.
- New titles/slugs are exact planned identifiers, not GitHub issue numbers. The creation agent
  resolves real numbers after deduplication and creation; no plan row is already executed.
- Dates remain targets, not promises or invented volunteer commitments. Claimed activity does
  not assign anyone. Self-hosting/GHCR publishing and release acceptance need a maintainer.
- Only this document is edited by T2, uncommitted; unrelated or concurrent docs/spikes from
  another agent must be preserved and reported separately during final worktree verification.
