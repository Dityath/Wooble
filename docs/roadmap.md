# Product roadmap

This is Wooble's initial, revisable plan for usable releases. The [public GitHub Roadmap](https://github.com/users/Dityath/projects/1/views/2) displays the release items and target dates. Dates are targets for planning, not promises. Each release has an outcome that people can try; a two-week checkpoint does not turn unfinished work into a release. Maintainers review progress and contributor availability at every checkpoint, update the target dates openly when needed, and tag a version only after its criteria of done are met.

`v0.1.0` is the published first public preview described in [versioning](versioning.md) and the baseline for the sequence below. If a later release moves, review the following dates rather than compressing the remaining work automatically.

| Release | Initial target | User-facing outcome |
| --- | --- | --- |
| `v0.2.0` | 10 October 2026 | Collaborative documentation |
| `v0.3.0` | 24 October 2026 | Usable connector contracts |
| `v0.4.0` | 7 November 2026 | Editable database diagrams |
| `v0.5.0` | 21 November 2026 | Contextual comments and discussion |
| `v0.6.0` | 5 December 2026 | Stability and user experience improvements informed by use |

## How to use this roadmap

The release entries are product outcomes, not claims that all implementation work is already scoped or assigned. The public GitHub Project has one draft item per release so anyone can see the timeline without creating an issue for every idea. When a contributor-ready piece of work is agreed, create a focused issue with an observable outcome, acceptance criteria, and relevant access rules. Link it to the release item. Follow [reporting and choosing issues](reporting-issues.md) for triage and claiming. A release item can remain visible even when no issue or contributor is assigned.

At each two-week checkpoint, record what was demonstrated, what remains, the currently available contributors, and any revised target date. Do not treat an empty assignee or a target date as a commitment from a volunteer. Fix release-blocking defects before tagging. After a release, urgent defects may ship as patch versions without waiting for the next planned minor release.

Across all releases, preserve the semantic architecture model as the source of truth. Documentation belongs to the architecture entity, and contracts belong to the semantic connection, even if either is opened from several canvases. A database diagram describes a database entity; its table positions are presentation data. Canvas-specific discussion may additionally refer to a particular canvas placement. Access to every new record and live channel follows the relevant workspace, canvas, and object permissions. A link-shared guest or viewer can read allowed content but cannot edit it or gain access to other workspace data.

### Shared release gate

Each release is done only when:

- Its user journey works from a fresh self-hosted install and, where applicable, from an upgrade of the previous release without losing existing content.
- Relevant editors, viewers, workspace roles, and link-shared guests have their intended read/write behavior checked through registered API routes and browser journeys. A revoked user loses access to live sessions.
- Changed behavior has meaningful automated tests; relevant lint, format, typecheck, build, database integration, and browser checks pass. The maintainer reviews results and remaining limits.
- UI has usable loading, empty, error, save, and reconnect states, plus keyboard and accessible-label behavior for its primary actions.
- Documentation, migrations, release notes, upgrade steps, and known limitations reflect what actually shipped. No release tag is created solely to meet a target date.

## `v0.2.0` — Collaborative documentation

**User journey.** A member opens the documentation of a node, writes using a block editor with a `/` menu, imports an existing Markdown file, and works in the same document as another permitted member. Both can see who has the document open and where the other person is editing. The documentation remains the same when that architecture entity appears on another canvas.

**Criteria of done**

- The editor supports paragraph, heading, bullet and numbered list, task list, quote, code block, divider, and table blocks. Typing `/` opens a searchable, keyboard-operable menu and inserts the selected block at the current position.
- Importing `.md` or pasting Markdown maps supported constructs to blocks. The import flow previews replacement or insertion, does not silently discard unsupported content, and existing Markdown documentation remains readable and editable after migration.
- Two permitted editors can type in the same document concurrently without one save replacing the other's work. Reconnect and refresh restore persisted content; an interrupted save or sync has a visible state and recovery path.
- The document shows the people currently viewing it. Other editors' live carets and selections appear in the document with identifiable names or colors and disappear when they leave. Canvas cursor presence alone does not satisfy this criterion.
- Viewers and link-shared guests with access can read but cannot write. Editing, document presence, and updates remain scoped to the entity's workspace and authorized canvas context.
- Markdown export or copy produces a useful representation of supported blocks. Round-trip checks cover the documented supported constructs; any unsupported format has a visible, documented limit.

**Dependency.** Choose and test a collaborative document representation and persistence/recovery model before replacing the current Markdown field. Keep document presence separate from durable content.

## `v0.3.0` — API and Protobuf contracts

**User journey.** A member selects a connector, reads its contract, imports OpenAPI JSON or a `.proto` file, or creates a contract in Wooble. They can edit a suitable visual form or its source, validate the result, and work alongside another permitted member. Other viewers can understand the interaction between the connected nodes without opening an external tool.

**Criteria of done**

- Contracts have an explicit format and are attached to the semantic connection. All connector types can hold and display a contract; the interface does not mislabel a generic or event contract as HTTP.
- REST connectors can import OpenAPI JSON, show operations, paths, parameters, request and response shapes, and edit them with clear validation. Editing the visual form does not silently erase source fields it does not expose. The supported OpenAPI version and limits are documented.
- Protobuf connectors can import `.proto`, identify package, services, methods, messages, and fields, and offer a useful source and structured reading/editing experience. Local imports/dependencies are resolved or reported clearly; a single unresolved file is not presented as a valid compiled contract.
- A member can create a contract without importing a file, save it, reopen it from another canvas showing the connection, and export its source. Invalid source produces actionable errors and does not replace the last valid saved contract without an explicit choice.
- Two permitted editors can see who has the contract open and what section or operation the other is viewing or editing. Concurrent changes have a defined merge or conflict flow that avoids silent lost updates; reconnect is recoverable.
- Viewers and link-shared guests see only contracts they may read and cannot edit. Access checks cover the connection's actual registered route and workspace/canvas scope.

**Boundary.** Kafka, NATS, and other connector types need a usable format-aware source view and clear type labels in this release. Rich visual editors for event contracts, such as AsyncAPI channels and messages, can follow after the HTTP and Protobuf journeys are proven. This does not promise synchronization with external API or schema registries.

## `v0.4.0` — Database diagrams

**User journey.** A member opens a database entity, gives its schema diagram a name and purpose, imports a PostgreSQL SQL schema or creates tables visually, and inspects columns, primary keys, foreign keys, and relationships. A reader can understand what is stored and how tables relate. The diagram is available wherever the same database entity is shown.

**Criteria of done**

- Users can add, rename, and remove tables and columns; set common data types, nullability, defaults, primary keys, and foreign keys; and create or change valid relationships through the visual editor. Changes are persisted and survive refresh.
- Importing the documented PostgreSQL DDL subset produces the same tables and relationships in the diagram. Unsupported statements and unresolved references are reported without silently discarding the source or damaging an existing diagram.
- The saved schema is the source of truth; diagram positions and viewport are stored separately. Moving a table never changes its database definition. Relationship lines identify their source and target columns and remain legible as the diagram grows.
- The diagram has a name and purpose, can be read without entering edit mode, and shows a usable state for empty, invalid, and larger schemas. At least one export path preserves the supported schema information.
- Edits to tables, keys, and relationships validate references and surface conflicts. Viewers and link-shared guests can inspect authorized diagrams but cannot change them. The database entity remains workspace-scoped even when shown on multiple canvases.
- If database elements are associated with Protobuf messages or fields, that association is explicit. Generating a service contract from tables is not automatic or required for this release.

## `v0.5.0` — Comments and discussion

**User journey.** A member leaves a contextual comment on a node or connector, highlights text in documentation to discuss it, or comments on a contract or a table/column in a database diagram. Others can reply, mention a permitted teammate, follow the link to the context, and resolve or reopen the thread.

**Criteria of done**

- Members can create, reply to, resolve, and reopen threads on entities, connections, documentation text, contract operations or sections, and database tables or columns. A comment indicator leads to the exact object or the closest remaining context when its anchor changes.
- Canvas comments use an unobtrusive pin or contextual marker similar to a design review. Text comments stay attached to the selected passage as concurrent edits change nearby content; orphaned anchors are visible and recoverable rather than silently lost.
- `@mention` searches only people eligible for the context. Mentioned people receive a discoverable in-app notification or inbox entry and can open the thread if they still have access. No mention leaks private content to an unauthorized account.
- Thread authorship, creation and edit time, resolve state, and replies persist. The UI distinguishes open from resolved discussions and lets readers find both without overwhelming the canvas or reading surface.
- Comment and mention routes enforce the current workspace/canvas/object access rules. Editors and higher roles can comment; viewers and link-shared guests can read authorized threads but cannot write. A guest is never granted write access simply by opening a shared link.
- Existing documentation, contracts, and schema diagrams remain editable with comments present. Moving or deleting an anchor has a defined outcome tested in the affected editor.

## `v0.6.0` — Stability and user experience

**User journey.** Someone using the four new capabilities can move from canvas to detail, make or review a change, recover from a failure, and return to the architecture without confusion. The release responds to issues actually found by users and contributors, rather than promising an unbounded redesign.

**Criteria of done**

- The maintainer triages feedback from `v0.2.0`–`v0.5.0`, publishes a bounded list of release-blocking defects and highest-impact usability improvements, and records which items are in scope for `v0.6.0`. Unresolved known limits are documented.
- Release-blocking data loss, access-control, migration, and primary-journey defects found during triage are fixed and regression-tested. Other urgent fixes may be released earlier as patches.
- The primary documentation, contract, database, and comments journeys use consistent navigation, labels, save/reconnect feedback, and read-only states; focused browser checks cover desktop and narrow layouts and keyboard use.
- A contributor can follow the documented fresh-install and previous-release upgrade paths and inspect the resulting content. Performance and usability regressions found in realistic multi-user or larger-document/schema cases are measured and addressed or explicitly documented.

## Beyond these releases

External source synchronization, richer visual editors for Kafka/NATS contracts, and automatic mapping from database tables to service messages remain separate proposals. They may be brought forward through accepted issues, but are not implicit criteria for the dates above.
