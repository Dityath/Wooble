# ADR: Collaboration sync model for documentation

Status: **Proposed — not accepted until maintainer review and merge.** Nothing in this document is implemented. The only runtime evidence is the isolated [transport spike](../spikes/2026-10-13-collaboration-sync.md). No dependency, contract, schema, migration, route, or UI changes accompany this ADR.

**Review status.** On 2026-10-13 an independent documentation review (code, architecture, security, and persistence/query perspectives) was run on this branch. Round-1 findings were incorporated into this document. Maintainer acceptance is still pending.

Issue: [#16](https://github.com/Dityath/Wooble/issues/16). Tracking: [release backlog](../release-backlog.md). Date: 2026-10-13.

## Context

The v0.2 roadmap asks for concurrent editing of entity and connection documentation. Today documentation is the Markdown string `metadata.documentation` (Zod `max(20000)`, trimmed) on `entities` and `connections`, written by `PATCH /api/entities/:entityId` and `PATCH /api/connections/:connectionId` with last-write-wins semantics. `contractBody` (connections) and `schemaSql` (entities) are separate strings with `max(100000)`; this ADR does not change them.

Facts about the current code that constrain the design:

- `apps/api/src/lib/live.ts` registers one WebSocket route, `/api/canvases/:canvasId/live`. It sends JSON text, caps inbound messages at 256 bytes by wrapping the Bun message dispatcher, rechecks canvas read access every 30 seconds, and closes sockets on selected canvas mutations. Guests (no account) connect when `canvases.share_mode = 'link'`. It is not a binary sync channel and is not reused for document sync.
- `apps/api/src/lib/auth.ts` classifies routes by `context.route` pattern. A guest may read `/api/entities/:entityId` only with a `canvasId` query that names a link-shared canvas where `canvas_nodes` contains the entity. Entity and connection writes by a non-manager require the `editor` role on **every** canvas that shows the object; workspace managers (and system admins) pass. Whether that cross-canvas write rule is right is an open decision (`shared/multi-canvas-write-rule` in the [backlog](../release-backlog.md)); sync must not invent a different rule.
- An entity or connection belongs to one workspace (`entities.workspace_id`, `connections.workspace_id`) and can appear on many canvases through `canvas_nodes (canvas_id, entity_id)` and `canvas_connections (canvas_id, connection_id)`.
- `PATCH /api/entities/:entityId` and `PATCH /api/connections/:connectionId` (lane 1, `apps/api/src/modules/entity/routes.ts`, `connection/routes.ts`) lock every canvas showing the object `FOR UPDATE` in ascending id order (`withCanvasLocks`, `apps/api/src/modules/canvas/activity.ts`), then the shared entity or connection row `FOR UPDATE` until commit, and record the `canvas_events` row (`recordCanvasEvent`) in the same transaction. Canvas undo of `entity.updated` and `connection.updated` (`apps/api/src/modules/canvas/undo.ts`) restores only the metadata keys the original PATCH named: current events are written as v2 event metadata (`previousMetadataEntries`, `canvas/event-metadata.ts`, called from `entity/routes.ts` and `connection/routes.ts` with `Object.keys(body.metadata)`), and undo applies them key by key (`isUpdateEventMetadataV2`, `applyPreviousMetadata`). Only pre-v2 legacy events restore a whole metadata snapshot (`legacyMetadata`). Both paths skip keys registered as external (`isExternalMetadataKey` / `registerExternalMetadataKey`, `canvas/undo-registry.ts`), so undo neither restores nor deletes them. `documentation` is not registered today, so undoing an event whose PATCH named `documentation` restores the old string over collaborative text; the future collab module closes that by registering it (see [Editor binding and undo](#editor-binding-and-undo)). The undo transaction locking is under [Lock order](#lock-order).
- This branch is Markdown-first: the inspector uses a plain `maxLength={20000}` textarea with preview (`rich-documentation.tsx`), and no TipTap or Yjs package is installed. The TipTap block editor (#9) and the integrity/registry work (#12) live on other branches and are **dependencies, not inherited behavior**.

## Decision

1. **Yjs 13 with `y-protocols` 1.x, implemented inside Wooble's own Elysia API process**, rather than a separate Hocuspocus server.
2. **One Y.Doc per stable document identity**, persisted in a new `collab_documents` table (planned), with a bounded Markdown mirror that keeps existing readers, exports, and the legacy `PATCH` contract working.
3. **Authorization is evaluated per frame on both receive and send**, against the server-derived workspace and the current canvas session context, never against a cached decision.
4. **Commit before acknowledge or broadcast.** Peers and the author's "saved" indicator only see state that is committed to PostgreSQL.
5. **Single API instance only** for the first implementation.
6. v0.3–v0.5 reuse the authorization and ephemeral awareness layer; they do **not** get automatic structured merge of contracts or schemas.

### Why Yjs in-process rather than Hocuspocus

Both are MIT; cost is not a factor. Versions checked 2026-10-13 against the npm registry: `@hocuspocus/server` 4.7.1 (MIT, `engines.node >= 22`, peers `yjs ^13.6.8`, `y-protocols ^1.0.6`); the spike used Yjs 13.6.33, y-protocols 1.0.7, lib0 0.2.119 (all MIT).

| Concern | In-process Yjs on Elysia | Hocuspocus server |
| --- | --- | --- |
| Persist-then-ack ordering | We control it: apply, persist, commit, then ack and broadcast. | Its documented persistence path is the debounced `onStoreDocument`; `onChange` fires after the document has changed. The hooks reference documents no pre-commit gate on broadcast. Not shown to be impossible; not offered. |
| Per-frame authorization | Native: every receive and every send passes the same function. | `beforeHandleMessage` and `beforeHandleAwareness` can reject inbound messages. A per-recipient pre-send hook was not found in the hooks reference (not exhaustively verified). |
| Auth model | Reuses the HttpOnly cookie, Origin allowlist, `canvasRole`, link-share check, and guard classification already in `apps/api`. | Token-oriented `onAuthenticate`; cookie and canvas-context rules must be re-expressed in hooks. |
| Wire compatibility | Plain y-protocols framing on a canvas-scoped route; the spike proved it on Elysia/Bun. | `HocuspocusProvider` multiplexes documents over one socket with its own envelope and is not compatible with a custom multiplexed route, so the web client and server must both be Hocuspocus. |
| Runtime fit | Same Bun process, same shutdown (`closeLivePeers`) and proxy rules. | Node >= 22 engine; Bun support is claimed in its docs, but was not tested by the spike or here. A second process adds a deployment unit and a second place for auth. |
| Operations | We own protocol correctness, decoder hardening, awareness handling, reconnect behavior, and a future Yjs 14 migration. More code and more tests for Wooble. | Maintained hook chain, retry-on-throw storage, Redis scale-out extension. |
| Horizontal scale | None; single instance (see Limits). | Redis extension exists; its maintainers note documents on different instances do not fully sync unless users are connected to both (hocuspocus issue 800, from the research brief; not re-fetched). |

Trade-off accepted: Wooble owns more protocol code in exchange for exact control of ordering and authorization that the product's access model requires. Embedding Hocuspocus's core inside Elysia through a custom adapter was **not** evaluated. If the release gates below fail for the in-process design, evaluate it before re-opening this decision.

### Reversibility

Stored state is standard Yjs update bytes and the wire framing is plain y-protocols, so the server side can be swapped later (for example for a Hocuspocus core) without migrating data. The client provider is the hard part: `HocuspocusProvider` is not wire-compatible with the plain framing. The web client therefore isolates the provider behind one adapter module so that a provider change does not touch editor code.

### Module boundary

Later releases depend on a document-kind-agnostic seam, not on room or queue internals:

- `authorizeFrame(sessionContext, docIdentity, capability)` evaluates one frame for one session and returns allow or deny (fail closed).
- A room and awareness API is parameterized by `object_kind` and `field` and has no Markdown or TipTap knowledge.
- The Markdown bootstrap, parser, serializer, and mirror projection are a plug-in for the `documentation` field. v0.3 and v0.5 add other fields or kinds by registering their own plug-ins, not by editing the room.

Do not use `@y/websocket-server` or `@y/protocols`: the default branch of [y-protocols](https://github.com/yjs/y-protocols) now documents `@y/protocols` (the Yjs 14 line). The spike pinned `y-protocols` 1.0.7 with Yjs 13 and used its installed `sync.js` and `awareness.js` as version-specific evidence.

### Editor binding and undo

- TipTap 3 `@tiptap/extension-collaboration` and `@tiptap/extension-collaboration-caret` are MIT. Checked against the npm registry on 2026-10-13: both 3.31.4, peers `@tiptap/y-tiptap ^3.0.7` and (for Collaboration) `yjs ^13`. The Collaboration extension binds through **`@tiptap/y-tiptap`** (a Tiptap-maintained fork of y-prosemirror, MIT); it does not depend on `y-prosemirror`, whose 1.3.7 release is the older binding. Use `@tiptap/y-tiptap`; some documentation snippets still mention `y-prosemirror`.
- Excluded: Tiptap Cloud / `TiptapCollabProvider`, `@tiptap-pro/*` packages, and any private-registry install. Self-hosted documents in Wooble's database do not need them.
- Disable StarterKit's history: `StarterKit.configure({ undoRedo: false })`. The [configure page](https://tiptap.dev/docs/editor/getting-started/configure) states this is required with `Collaboration` to avoid conflicts, and the [undo-redo page](https://tiptap.dev/docs/editor/extensions/functionality/undo-redo) says to use the plain extension only for non-collaborative editors.
- Undo uses Yjs `UndoManager` tracking only the **local** origin ([UndoManager docs](https://docs.yjs.dev/api/undo-manager): `trackedOrigins` selects which origins are tracked; the manager itself is always tracked). Remote updates, bootstrap, and the server's legacy-`PATCH` replacement use other origins and are never undone by a user's local undo.
- Canvas undo (`canvas_events`) and document undo are separate systems. The #12 activity registry gets **typed exclusions**: an `entity.updated` or `connection.updated` undo never restores `documentation` (or any other field owned by a document). Lane 1 already restores only the keys the PATCH named (v2 events; whole-snapshot restore is limited to pre-v2 legacy events) and already has the exclusion hook (`registerExternalMetadataKey` / `isExternalMetadataKey`, `apps/api/src/modules/canvas/undo-registry.ts`, honored by `applyPreviousMetadata` and `legacyMetadata` in `undo.ts`). The residual risk is that `documentation` is not registered: undoing an event whose `body.metadata` contained `documentation` restores that old string, and `previousMetadataEntries` copies the document text into event metadata. The collab cutover therefore registers `documentation` through that existing hook, which covers both the v2 and legacy paths; this implements an existing mechanism, not a new one. Event metadata should also stop copying large document strings into `previousMetadata`. The full single-writer rule, including the cutover precondition, is under [Single writer for `metadata.documentation`](#single-writer-for-metadatadocumentation).

## Document identity and access

### Identity versus session context

- **Document identity** (stable, storage key): `(object_kind, object_id, field)`, where `object_kind` is `entity` or `connection` and `field` initially `documentation`. Object IDs are globally unique UUIDs, so the workspace is not part of the key. The workspace is a **derived** column (`workspace_id`) read from the owner row on the server and verified equal to the owner row's workspace inside every commit transaction; a mismatch fails closed and is reported for reconciliation. A client-supplied workspace or kind is never trusted.
- **Session context** (per socket, short-lived): the actor or guest link, the canvas the user opened, the role on that canvas, and the proof that the object is shown there. One entity shown on three canvases is **one** document with three possible session contexts.
- The route is a new registered Elysia WebSocket route that includes the canvas ID and object reference in its path (exact path to be set by `v0.2/sync-access`). It must be classified explicitly in the access guard: the existing guard works on registered route patterns (`context.route`), and #10/#26 is moving toward default-deny for unclassified routes. On upgrade and on every frame the server verifies, in this order: Origin present and in the allowlist (a **missing** Origin is rejected on upgrade; see below); session valid and unexpired, or the canvas is link-shared for a guest; canvas exists and its `workspace_id` equals the object's `workspace_id`; the object is included on that canvas (`canvas_nodes` or `canvas_connections`); the role permits the requested capability. A missing object, a non-included object, and a forbidden object are indistinguishable to the client.
- **Read** requires read access to that canvas. **Write** must call the same eligibility function the legacy `PATCH` guard uses (today: workspace manager, or `editor` on every canvas showing the object). Do not reimplement it for sync; two writers with different rules would let the weaker path bypass the stronger. `v0.2/sync-access` is blocked on the cross-canvas write-rule decision and on #10/#26.
- Guests are read-only for life: no write capability, no editable caret, and by default no awareness exchange (most restrictive default; a later decision may allow an anonymous viewer count). Signed-in viewers may receive document state and appear in the participant list; their selections are shown, if at all, as read-only highlights.

### Access-guard prerequisites and gaps

Reading `apps/api/src/lib/auth.ts` shows the existing guard does not cover the sync route as it stands:

- **Origin on upgrade.** `accessGuard` only checks `Origin` for non-GET requests and lets a missing Origin through, so it does not protect a WebSocket upgrade (a GET). The upgrade handler must reject a **missing or non-allowlisted** Origin, reusing the logic in `live.ts` (which closes 1008 unless the header is in `allowedWebOrigins`). Covered by a test.
- **Write rule is not callable.** The write-eligibility rule lives inside `accessGuard`'s `onBeforeHandle` closure. Extracting it into a callable eligibility function is an explicit **prerequisite** so sync calls it rather than reimplementing it.
- **Missing resource passes the guard.** The guard returns without denying when the resource does not exist (`if (!resource) return;`). That is acceptable for a route that then 404s, but the sync route must **deny** (indistinguishably from forbidden).
- **Link-viewer rows persist (open decision).** `materializeLinkViewer` persists `canvas_members` viewer rows for signed-in users who open a link-shared canvas, and these rows survive disabling link sharing. Whether a materialized viewer should keep read access to live documents after link sharing is turned off is an **OPEN decision that blocks `v0.2/sync-access`**. This ADR does not decide it; until decided, the sync route cannot claim a revoke behavior for these users.

### Per-frame authorization

- **Order of checks.** Frame-size, rate, and byte-budget checks run **before** any database lookup and before any decode. Authorization queries themselves count against the rate budget, including the per-recipient authorization done during fan-out. A reader's frame is rejected before decode as well as before apply. SyncStep1 requests are rate-limited like any other frame (a flood of state-vector requests is a read amplification). If a bounded-TTL authorization cache is ever adopted (by amending this ADR), revoke and mutation events must invalidate it and it must still fail closed.
- Re-check session, role, link-share state, and object inclusion before **every receive** and **every send**, including initial sync, awareness frames, acknowledgements, and error frames. The result is valid for that one frame; there is no cross-frame cache. If a benchmark shows this is unaffordable, a bounded-TTL cache may only be adopted by amending this ADR.
- The authorization lookup failing (database error, timeout) **fails closed**: close the socket (1011), send nothing further.
- Fan-out iterates the room's currently registered peers and authorizes each recipient before sending. No raw Bun topic `publish` / `publishBinary` for document content: a subscribed-but-revoked socket would bypass the check.
- Work is serialized per socket and per document with a promise queue, so a frame is never processed concurrently with its own authorization. The persistence transaction re-reads the deciding rows (session, role/membership, share mode, inclusion) inside the commit transaction, after its locks, as defined by the single [revocation contract](#revocation-contract); this section does not restate it. Revoke and canvas-mutation events also detach and close the affected sockets immediately and remove their awareness state, keeping the existing `revalidatePeers` / `closePeer` hooks in `apps/api/src/lib/live.ts` (detach first, then close 1008, terminate after `terminateAfterMs`); per-frame checks are not a replacement for those hooks. The server is the only enforcement point: a modified client can replay an offline buffer, so nothing is trusted from the client's own notion of its role.
- Close codes and reasons are generic and fixed. Every authorization or identity failure uses 1008 with the same reason; internal and lookup failures use 1011; overload uses 1013; shutdown uses 1001; an application code in the 4000–4999 range (reserved for applications per Bun) signals "client upgrade required". No document text, titles, or role names appear in errors.

### Read-only peers

Readers may send a SyncStep1 (state vector) to obtain server state. The server does not initiate SyncStep1 toward readers. It rejects **both** inner `Update` and `SyncStep2` from a reader **before** `Y.applyUpdate`, because `readSyncMessage` applies both variants (the spike confirmed this on installed y-protocols 1.0.7). Authorization is evaluated again immediately before apply for editors.

### Awareness

- Identity is server-bound: the display name and color index come from the authenticated actor, not from the frame (as in `live.ts`, which already slices names to 32 characters).
- The awareness `clientID` is assigned or verified server-side. A claim of an ID already held by another socket is rejected. A socket owns exactly one ID; frames carrying other client IDs are dropped. Client clocks are ignored or bounded, so a client cannot pin or expire another's state. The server removes the socket's state on close **and** on revoke.
- Only whitelisted fields (`user` display fields, selection/caret as relative positions) are kept, each size-bounded. Unknown fields are dropped before re-encoding.
- Awareness is never persisted, never feeds the Markdown mirror, and a connected-but-silent peer expires by timeout. Awareness frames have separate (smaller) caps and rate limits than document updates.

### Content validation and served state

- **Per-commit validation.** Every candidate update is validated before commit: root types are whitelisted, nodes and marks conform to the editor schema, and link URL schemes are on an allowlist. The serialized mirror must pass the same sanitization as legacy content. The existing renderer's sanitizer should be verified before relying on it (not verified by this ADR).
- **Served state.** Documents use `gc: true` (or an explicitly stated alternative policy) and readers receive the **current** state, not deleted history. Release-gate test: text deleted by an editor is not recoverable from the state served to a reader.

## Persistence: `collab_documents` (planned design)

The following describes **planned** schema; no SQL below exists in the repository. Final migration is a checked-in additive migration generated by `drizzle-kit`.

| Column (planned) | Purpose |
| --- | --- |
| `id` | Surrogate key. |
| `workspace_id` | Derived, `NOT NULL`, FK to `workspaces`, `ON DELETE CASCADE` (matches `entities` and `connections`). Verified against the owner row on every commit. Planned **index on `workspace_id`** for cascade deletes and workspace-scoped reconciliation. |
| `object_kind`, `object_id`, `field` | Document identity. Unique on `(object_kind, object_id, field)`; all `NOT NULL` so uniqueness is not defeated by NULLs. |
| `state` | `bytea`, Yjs state; nullable (a placeholder row has `state IS NULL`). Backstop `CHECK (octet_length(state) <= cap)`; `octet_length(bytea)` exists ([binary functions](https://www.postgresql.org/docs/16/functions-binarystring.html)). |
| `mirror_markdown`, `mirror_sha256` | Markdown projection and its SHA-256 over the exact UTF-8 bytes; nullable until bootstrapped. Bounded to the existing 20000-**character** contract. |
| `original_markdown`, `original_sha256` | Exact Markdown (and hash) seen at first bootstrap; written once, immutable. Evidence for audit and operator recovery, not a CRDT substitute. |
| `schema_version`, `bootstrap_version` | Editor schema version and parser version that produced the state; `bootstrap_version IS NULL` (or `state IS NULL`) means not yet bootstrapped. |
| `revision` | Monotonic counter incremented in the same statement as `state` and mirror. |
| `quarantined_at`, `quarantine_reason` | Set instead of partially applying invalid state. |
| `deleted_at` | Tombstone (see Retention). |
| `created_at`, `updated_at` | Timestamps. |

Notes:

- **Character versus byte limits are different limits.** The mirror cap is the contract's 20000 characters. The Zod `max` counts JavaScript string length (UTF-16 code units); PostgreSQL `char_length`/`length` counts characters, so a database `CHECK` is a looser backstop, never stricter than the API. Byte caps apply to `state`, updates, and frames.
- **NUL and later bound changes.** PostgreSQL `text` and `jsonb` reject U+0000, so the Markdown parser rejects U+0000 in input. Changing a `CHECK` bound later needs an `ALTER TABLE` that validates the whole table, so choose bounds with that in mind.
- **Placeholder rows.** The state columns are nullable so a placeholder row can exist before bootstrap. "Bootstrapped" is detected explicitly (`state IS NULL` / `bootstrap_version`), never inferred from row existence.
- **Integrity gap.** `object_kind` and `object_id` is a polymorphic reference and has no database FK. An FK per kind with `ON DELETE CASCADE` would destroy the document when an entity is deleted, which conflicts with canvas undo restoring the same IDs. So the table depends on the #12 object registry for create, delete-to-tombstone, and restore hooks, plus a reconciliation job that reports orphans. This is a prerequisite, not provided here. Tombstone mechanics are under [Tombstones and cascades](#tombstones-and-cascades).
- **Cascade facts.** Workspace purge cascades to `collab_documents` and intentionally destroys retained history. Per PostgreSQL, deletes caused by foreign-key `ON DELETE CASCADE` fire the relevant row triggers on the affected table ([CREATE TRIGGER](https://www.postgresql.org/docs/16/sql-createtrigger.html)), so an audit trigger on this table would see cascade deletes.
- **Reader-facing mirror.** `entities.metadata.documentation` and `connections.metadata.documentation` remain the fields existing readers and exports use. They become a projection of `mirror_markdown`, written in the **same transaction**, so legacy API consumers see the same text and hash. A reconciliation check compares the two hashes.
- **Drizzle.** The installed Drizzle (0.44.7, per the research brief) exposes no `bytea` builder; a `customType` is needed. The `node-postgres` driver (`packages/db/src/client.ts`) returns a Node `Buffer` for `bytea` columns; whether the Drizzle `customType` round-trips it cleanly is **to verify**.

### Lock order

Current behavior (lane 1, `apps/api/src/modules/canvas/activity.ts`, `entity/routes.ts`, `connection/routes.ts`, `canvas/undo.ts`; summarized in `docs/architecture.md`): every transaction that changes canvas content locks canvas row(s) `FOR UPDATE` first, then the shared entity or connection row `FOR UPDATE` held to commit, and `recordCanvasEvent` then locks its canvas row, which is already held.

- `PATCH /api/entities/:id` and `PATCH /api/connections/:id` lock **every canvas showing the object**, in ascending `id` order (`withCanvasLocks`), then the shared row.
- Canvas undo locks the **requested** canvas (the route), then the object. Undo of `entity.updated` and of a non-bend `connection.updated` reads the shared row `FOR UPDATE` (`undo.ts`), so two undos reaching one object through different canvases serialize on the object row. Bend, placement, auto-neat, and `canvas.updated` undos only touch rows owned by the locked canvas.
- Undo (`applyNextUndo`, `undo.ts`) has a decision phase and an apply phase. The **walk** (decision phase) walks candidates newest-first using unlocked reads only: authorization (`undoAuthorized`), the blocked-state endpoint check (`existingEntities(tx, ids, lock=false)`), the conflict scan, and the no-op test. Beyond the route's canvas row `FOR UPDATE`, a candidate that is skipped or found a no-op in the walk takes no share-class (`FOR KEY SHARE`) and no update lock. Locks are taken only in the **apply phase**, for the one candidate actually being undone (`undoBlockedByCurrentState(tx, candidate, true)`, then `applyUndo`): `entity.updated` and non-bend `connection.updated` read the row unlocked, then take it `FOR UPDATE` (canvas, then object, the order PATCH uses), re-run `undoAuthorized` (write access) through the transaction, recompute the plan, and re-compare; a refused candidate is skipped as a conflict without writing. A candidate that turns out to be blocked or refused is skipped as `conflict`. The route (`canvas/routes.ts`, the `applyNextUndo` call near line 852) answers 409 `undo_conflict` only if at least one skipped item has reason `conflict`; a walk that skipped only no-ops answers `{ undone: false }`.
- Undo of `entity.created`, `connection.created`, and subtree delete locks the rows to delete `FOR UPDATE` in ascending id order (`lockRows`), only after the early "not placed on this canvas" return. Undo of restores (`connection.deleted`, `entity.deleted`, `canvas.auto_neat`, and `placement.updated` with a restorable `from`) takes the endpoint entities `FOR KEY SHARE` in ascending id order (`existingEntities` with `lock=true`, called only from the apply phase) and holds them to commit, so a concurrent delete cannot slip in; it re-checks the blocked state under that lock and, if blocked, skips the candidate as a conflict without writing. Once the lock is held and the re-check passes, the restore always writes (it only inserts rows that reference the endpoints), and every applied candidate that took `KEY SHARE` ends the walk, so no `FOR UPDATE` on those rows follows in the same transaction. This is consistent with the [no-upgrade rule](#no-lock-upgrade-rule).
- `retryOnLockConflict` (`undo.ts`, used by the undo route) reruns the whole undo transaction on PostgreSQL 40P01 or 40001, up to 3 attempts, then throws `CanvasLockContention` (503), the same class the PATCH routes use.
- **Known residual in undo (a documented, narrow exception to the no-upgrade rule).** An update candidate that becomes a no-op only after its `FOR UPDATE` was granted keeps that lock while the walk continues; and a restore found blocked under its `KEY SHARE` keeps `KEY SHARE` on the endpoints that still exist while the walk continues. A later `FOR UPDATE` on the same row in the same transaction would then be an upgrade. Both cases need a concurrent change between the unlocked check and the lock, so the resulting 40P01 is rare, and `retryOnLockConflict` absorbs it. This residual is specific to the undo walk and is not available to new code, including the collab path.
- `FOR KEY SHARE` appears in `apps/api/src` only in `existingEntities` with `lock=true` (`.for("key share")`, `undo.ts`); there is no `FOR SHARE`. The canvas lock alone does not protect a shared object, which is why the object row is locked too.

One global lock order applies to **every** path that writes a document, legacy or collaborative (this is the v0.2.0 requirement; the collab path does not exist yet):

1. canvas rows involved (sorted by `id`), locked `FOR UPDATE`, then
2. the owner entity or connection row, locked `FOR UPDATE` like the legacy routes, or `FOR NO KEY UPDATE` if the implementation needs foreign-key inserts such as `canvas_nodes` (which take `FOR KEY SHARE`) not to block; either conflicts with the legacy `FOR UPDATE`, so mixed writers still serialize, then
3. the `collab_documents` row.

Canvas lock strength. Existing canvas content mutations take the canvas `FOR UPDATE` (`apps/api/src/modules/canvas/routes.ts`). A sync commit takes the sorted canvas rows `FOR UPDATE` too: that makes a placement add, remove, or undo order strictly before or after the commit's inclusion check, and it lets the commit record a `canvas_events` row (which locks the canvas row) without a lock upgrade. The cost is that commits on documents shown on one canvas serialize on that canvas row for the length of a short transaction; this is accepted until measured otherwise. A `FOR SHARE` canvas lock is possible only for a commit that records no event and writes nothing to the canvas row (`recordCanvasEvent` always locks the canvas `FOR UPDATE`); any other commit takes `FOR UPDATE` from the start ([no-upgrade rule](#no-lock-upgrade-rule)).

#### No lock-upgrade rule

A transaction that may write a row must take `FOR UPDATE` (or `FOR NO KEY UPDATE`) on that row **from the start**. "May write" includes indirect writes: recording a `canvas_events` row (which locks the canvas row), bumping a sequence or `updatedAt`, touching a canvas, or the tombstone trigger updating a `collab_documents` row. It must never take `FOR SHARE` or `FOR KEY SHARE` on a row and later upgrade by writing or locking it `FOR UPDATE`. Why: two transactions can each hold the shared lock and then each wait for the other to release it so it can upgrade; neither can proceed and PostgreSQL aborts one with a deadlock error. Lane 1 follows this in the decision phase and for every update (`undo.ts` takes the object `FOR UPDATE` up front, "never FOR SHARE first"; the walk takes no share-class lock, and its one `FOR KEY SHARE`, on restore endpoint entities, is taken only for the candidate being applied, which always writes and ends the walk). The narrow exception, named under [Lock order](#lock-order), is a no-op update or blocked restore whose lock is kept while the walk continues; it needs a concurrent change and the retry absorbs the resulting deadlock. The rule has no such exception for new code. It applies to the future collab path wherever a Yjs update is applied and then recorded as an event or projected into the owner row: the canvas rows and owner row must be locked for update before the apply. `FOR SHARE` on a row is acceptable only for a transaction that, on every code path, never writes or locks that row for update afterwards, and the two-connection tests must cover that claim.

Stale lock set. The canvas set is derived from `canvas_nodes` / `canvas_connections` read **before** the locks exist. After taking the canvas locks, the commit re-reads the inclusion set; if it changed, it releases (rolls back) and retries a bounded number of times, then aborts with a retryable close. This is what `withCanvasLocks` already does (`CanvasSetChanged`, at most five attempts, then `CanvasLockContention`, answered 503). Never commit against a lock set that no longer matches inclusion.

Session and membership rows. `sessions`, `canvas_members`, and workspace-membership rows are **read without row locks, after the canvas locks and the owner lock, inside the same commit transaction** (after position 3 above, read-only). Justification: locking them would add a second lock family whose order against revoke paths must also be proven. Under READ COMMITTED, a revoke that commits before the read is seen. A revoke that goes through a canvas mutation also takes the canvas row `FOR UPDATE`, so it orders strictly before or after the commit; a pure session or membership revoke can commit between the read and the commit, which is the one frame the [revocation contract](#revocation-contract) allows. Any revoke path that does take row locks on these tables (session delete, member removal, share-mode change) must follow the same order: canvas rows first, then session / membership rows, and must never lock them and then wait for a canvas row.

#### Revocation contract

This is the only statement of the revocation guarantee; other sections refer to it.

- **Definitions.** The *authorization check* of a write frame is the read of the deciding rows (session, role/membership, share mode, inclusion) inside its commit transaction, after its locks (above). A frame is *in flight* once that check has started and until its transaction commits or aborts. *Revocation commits* when the revoking transaction commits.
- **Guarantee.** No frame whose authorization check starts after a revocation commits is applied. At most one frame per socket that is already in flight may still commit after the revocation commits (frames are processed one at a time per socket by the promise queue). Strictly serialized revocation, "no frame commits after the revocation commits", is **not** promised.
- **Where it is exact.** A revoke that locks the canvas row `FOR UPDATE` (share-mode change, canvas update, placement removal) cannot commit between a frame's check and commit, because the frame holds that lock. For these the frame lands strictly before or after.
- **Where it is bounded.** A revoke that takes no canvas lock (session delete, workspace-membership removal, and today canvas member add, role change, or removal) can commit between a frame's check and its commit. That frame is the one allowed in flight. Afterwards `live.ts` detaches the socket before closing it, and fan-out re-authorizes each recipient, so nothing further is sent or applied.
- **Canvas member routes (current behavior, v0.2.0 requirement).** `POST`, `PATCH`, and `DELETE /api/canvases/:canvasId/members` in `apps/api/src/modules/canvas/routes.ts` do plain writes to `canvas_members` without a canvas lock, so a member change is in the bounded bucket. The contract treats member changes as bounded. Optional tightening: make those routes take the canvas row `FOR UPDATE` first, which would move them to the exact bucket; it is not required.
- **Current code.** The live canvas socket (`apps/api/src/lib/live.ts`) has no document writes. It rechecks read access every 30 seconds and at once on revoking events (`revalidatePeers`), detaches the peer, then closes it; this contract adds nothing to it.
- **How the collab path must uphold it.** Re-check access in the commit transaction under the canvas lock described above, never from a cached result of an earlier frame; on any check failure or database error, fail closed (1008 or 1011) and discard the frame. The two-connection tests must show both the exact and the bounded case.


#### Why this order, and the release gate

Existing canvas mutations take the canvas `FOR UPDATE` first and then write `entities` / `canvas_nodes`. A sync commit that locked the owner row first and then needed a canvas row (to re-check inclusion) would deadlock against placement add/remove and undo. The legacy `PATCH` routes already follow canvas then object, so they stay compatible. Alternative, noted and not chosen: lock a share-mode row and re-check inclusion without taking the canvas lock, accepting a wider revoke window. Release gate: a two-connection deadlock test against canvas placement add, remove, and undo (including two undos reaching one object through different canvases, a no-op-walk test showing that candidates skipped or found a no-op in the walk take no share-class or update lock, and the regression test "takes no shared lock on an entity while walking past a skipped candidate to an older update of it" (`apps/api/tests/canvas-event-transaction.test.ts`); undo retry on 40P01/40001 is covered by the retry test in the release gates below), against **entity delete vs sync commit** (the delete takes the owner `FOR UPDATE`; the tombstone trigger path runs canvas → entity → document, see [Tombstones and cascades](#tombstones-and-cascades)), against a concurrent change of the inclusion set between the pre-lock read and the lock, and a test that no code path takes a shared lock and then upgrades it.

### First bootstrap

1. Open a **short** transaction at **READ COMMITTED** (stated explicitly). Take locks in the order above. Obtain the document row either by `INSERT … ON CONFLICT DO NOTHING` followed by `SELECT … FOR UPDATE` ([INSERT](https://www.postgresql.org/docs/16/sql-insert.html), [explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html)), or by the single-statement `INSERT … ON CONFLICT (object_kind, object_id, field) DO UPDATE SET id = collab_documents.id RETURNING *`, which locks the row it returns. The placeholder first is required: `FOR UPDATE` on a missing row locks nothing. The two-step form relies on READ COMMITTED: under REPEATABLE READ or SERIALIZABLE, the `SELECT` after a conflicting insert can be rejected for a serialization failure or fail to see the concurrently committed row, so the two-step form breaks; use the single statement form if a higher isolation level is ever imposed.
2. After locking the owner row, **re-check that the owner still exists**: a `FOR NO KEY UPDATE` that waited behind a concurrent delete returns zero rows under READ COMMITTED. Zero rows means abort, no bootstrap.
3. If the row is already bootstrapped (detected explicitly), stop; do not parse again.
4. Run the **single canonical server-side** Markdown to `XmlFragment` parser. Clients never seed documents, and two clients never both seed. Input containing U+0000 is rejected.
5. Verify: the parser accepts every construct (no lossy or unsupported content), the result is within the 20000-character mirror cap, and parse → serialize → parse is stable. Otherwise reject: leave `metadata.documentation` untouched and the object on the legacy path, with a reportable reason.
6. Write state, mirror, original (once), hashes, versions, revision, and verify `workspace_id` equals the owner's; commit. Do not hold any transaction across a WebSocket.

### Bootstrap fidelity policy

The immutable original is kept exactly. The mirror is `serialize(parse(original))`, which may differ from the original (canonicalization). Therefore:

- **Automatic and batch backfill** bootstraps only documents where `serialize(parse(original))` equals the original **byte-for-byte**. Others stay on the legacy path.
- A document that does not round-trip is bootstrapped only after a **user-visible preview and confirmation** on first collaborative open (ties to `v0.2/markdown-fidelity`).
- **Base-hash after canonicalization.** `mirror_sha256` is computed over the canonicalized mirror. If a confirmed bootstrap changes the Markdown, a legacy client's base hash (of the pre-canonical text it read) no longer matches, so it receives one 409 with the current mirror and hash and must refetch. After that, hashes agree.

### Per-document persistence and failure handling

- A per-document queue serializes apply and persistence. Each commit writes `state`, mirror, hash, revision, and the `metadata.documentation` projection in **one transaction**, taking locks in the [global lock order](#lock-order) to avoid deadlock with the legacy `PATCH` and with canvas mutations.
- Acknowledgement and broadcast occur **only after COMMIT**. Yjs has no acknowledgement of its own, so durable acks need an application-level message; the spike wire format has none yet.
- No poisoned in-memory state. Primary design: validate and serialize the candidate update on a **clone** of the resident document, persist, and only after commit apply the same update bytes to the resident document and publish. Fallback if cloning cost fails its benchmark: apply on the resident document while withholding broadcast and ack, and on any persistence failure discard the resident document, reload the committed row, and close that document's sockets with a retryable code so clients reconcile from the authoritative state. Either way a database failure never leaves "acknowledged" and "live" state diverging.
- **Per-commit metadata write cost.** Projecting the mirror rewrites the whole `metadata` jsonb of the owner row, which may also hold up to 100000 characters each of `contractBody` or `schemaSql`. That is MVCC and TOAST churn on a hot row. **[needs measurement]**. If measured too costly, the projection may be debounced with bounded lag; this sacrifices the guarantee that legacy readers see the mirror in the same transaction as the CRDT commit (legacy `PATCH` base-hash checks must then compare against `collab_documents.mirror_sha256`, not the projection).
- **Activity policy.** Collaborative commits do **not** emit per-commit `canvas_events`. Proposal: one coalesced session-level activity record per editing session (for example on session end or at most every N seconds), and `updated_at` on the owner bumped at most every N seconds. N is to be set by measurement.
- **Write amplification of full-state rewrite.** Rewriting the whole `state` bytea per commit (up to the 2 MiB cap) amplifies writes. Budget to be documented by `v0.2/durable-documents`; the options are an incremental update log with periodic compaction, or whole-state replacement with measured limits. **[needs measurement]**. When a document reaches the state cap it becomes unwritable, so a compaction or GC path is required before the cap can be hit in practice.
- Frequent commits are expensive; updates within a short window may be coalesced into one commit (proposal: tens to a few hundred milliseconds), at the price of that much extra latency before peers see an edit.
- If persisted state fails schema validation (for example after a schema change), the document is **quarantined**: never partially applied, last committed mirror stays readable, writes are refused until an operator resolves it.
- Decoder risk: applying an untrusted update costs CPU and memory in proportion to its structure, not only its bytes. Size limits alone are insufficient. The research brief reports that an upstream Yjs pull request adding update size limits was open and unmerged on 2026-10-13 (lead, re-verify at implementation). Planned mitigations: reject early on frame size, decode and apply untrusted bytes under a wall-clock and memory budget (for example in a worker that can be terminated), count repeated failures per socket and close it. Not proven by the spike. No exploit payloads are published here.

### Single writer for `metadata.documentation`

Once a field is bootstrapped, the collab module is the **only** writer of `metadata.documentation`, exposed as a small interface called by the entity and connection routes and by undo/restore. Writers found today that would otherwise bypass it:

- `PATCH /api/entities/:entityId` (`apps/api/src/modules/entity/routes.ts`) and `PATCH /api/connections/:connectionId` (`apps/api/src/modules/connection/routes.ts`) merge `body.metadata` into the row's `metadata`; the contracts allow a `documentation` key (`packages/contracts/src/entity.ts`, `connection.ts`). These go behind the base-hash 409 gate (see [Legacy `PATCH`](#legacy-patch-metadatadocumentation)) and are routed through the collab interface.
- Canvas undo of `entity.updated` and `connection.updated` (`canvas/undo.ts`, `undoConnectionUpdated`) restores the keys the PATCH named (v2 events: `applyPreviousMetadata`) or, for pre-v2 legacy events only, a whole snapshot (`legacyMetadata`). `documentation` is not yet registered as an external key, so an event whose PATCH named it restores the old string. Registering `documentation` through `registerExternalMetadataKey` covers both paths.
- Delete-undo: `restoreConnection` and the connection snapshots inside `restoreEntitySubtree` re-insert stale metadata; `restoreEntitySubtree` also re-inserts entity snapshots. The DELETE entity route captures a pre-delete snapshot (stored in `canvas_events` metadata) with full documentation text, and `restoreEntitySubtree` writes it back. `documentation` must be **excluded from that snapshot**, which also reduces event bloat.
- The dev-only seed (`packages/db/src/seed.ts`, `onConflictDoUpdate` setting `metadata` on entities and connections) must not carry `documentation`.

**Cutover precondition (before sync is enabled):** typed exclusion of `documentation` from undo and restore, **and** re-projection of the mirror from `collab_documents` inside the same transaction after a restore. Delete-undo of the same entity or connection id must **un-tombstone** the `collab_documents` row (clear `deleted_at`) and re-project the mirror from its CRDT state, never from the snapshot. Release-gate negative test: no route writes `metadata.documentation` except through the collab interface, checked by hashing around every write path.

### Tombstones and cascades

Hard deletes happen in application code (`deleteEntitySubtree`, which has a check-then-delete race) and through database cascades (entities to connections via source/target, workspace purge). Application hooks cannot see database cascades. Therefore:

- Tombstone marking (`deleted_at`) must occur in the same transaction on **every explicit delete path**.
- Cascade-only paths are enumerated (entity delete cascading to its connections; workspace purge) and each is either marked or documented as intentionally destroying history.
- Consider an `AFTER DELETE` trigger on `entities` and `connections` that sets `deleted_at` on the matching `collab_documents` rows, so cascades are covered without app hooks.
- Lock interaction: an entity delete takes the owner row `FOR UPDATE`, and the tombstone trigger then updates the `collab_documents` row, so its path is canvas → entity → document, the same as the [global lock order](#lock-order). It is covered by the entity-delete-vs-sync-commit deadlock test.
- Restore: delete-undo of the same id clears `deleted_at` and re-projects the mirror from the CRDT state, not from the snapshot (see [Single writer](#single-writer-for-metadatadocumentation)).
- The retention window is policy and its duration is undefined here. Reconciliation reports orphans; it does **not** provide or enforce retention.

## Migration, backfill, recovery, rollback

- **Migrations.** Future checked-in, additive migrations only; existing migration files are never edited. `drizzle-kit` has no down migrations, so rollback of schema is a forward migration, and the preferred rollback is to leave the table dormant.
- **Backfill.** Resumable and idempotent: lazy bootstrap on first open, plus an optional batch job that keyset-paginates by object ID, one short transaction per object, using the same locks and the same `ON CONFLICT DO NOTHING` insert. Objects that fail bootstrap checks, or whose original does not round-trip byte-for-byte, are recorded and stay legacy (see [fidelity policy](#bootstrap-fidelity-policy)). Bootstrap is application logic, not SQL, so it is not part of a `drizzle-kit` migration.
- **Cutover order.** (1) Ship additive table and the **gated** legacy `PATCH` (below) with sync disabled; (2) enable bootstrap; (3) enable the sync route. Without step 1 first, a legacy writer would overwrite the mirror and diverge from the CRDT.
- **Recovery.** PostgreSQL backups and snapshots are authoritative for CRDT history. The immutable first seed and the Markdown mirror can restore text but not history or concurrent-edit structure; they are not a substitute for backups.
- **Rollback.** Retain the table. Old pre-cutover code writes `metadata.documentation` without touching the CRDT, so blindly restoring the old writer is unsafe. Procedure: freeze writes (sync and legacy document writes), drain per-document queues until committed, export and verify that every mirror hash equals its `metadata.documentation` hash, then roll back. On roll-forward, a mismatch between the two hashes means a legacy writer ran; the server must refuse to serve the stale CRDT silently and require an explicit operator choice (adopt the Markdown as a new baseline, discarding CRDT history for that document, or restore from backup).
- **Retention.** Object delete sets a tombstone (`deleted_at`; see [Tombstones and cascades](#tombstones-and-cascades)) and keeps the state until the **undo horizon** defined by #12. This ADR does not define a duration. Undo restores the same object IDs and the same canonical CRDT state, not a replay of old metadata. Workspace purge cascades and destroys retained history by design.

## Legacy `PATCH metadata.documentation`

A future API change (contracts are **not** changed now). Once an object's `documentation` is bootstrapped:

- The server applies a legacy write as a **server-side replacement inside the Y.Doc** (origin distinct from user and remote origins), then persists as above.
- It requires a **base-hash precondition**: the client states the SHA-256 of the Markdown it last read, and the server compares it with the current `mirror_sha256` while holding the [global lock order](#lock-order) locks (canvas rows, then the owner row), as the legacy route already does. Mismatch returns **409** with the current mirror and hash. The exact shape (a request header or a body field next to `metadata`) is for `v0.2/sync-access` to set; it must not be a wildcard.
- A client that sends no hash **cannot overwrite** a bootstrapped field; it receives 409 telling it to upgrade. There is no force flag.
- Setting `null` or `""` (which today deletes the key) follows the same precondition.
- Other metadata fields keep today's contract behavior. Readers and export continue to use the ≤20000-character mirror.
- Rich or unsupported Markdown that the canonical parser cannot represent is refused (no silent drop, no partial apply); the response says the content is unsupported for collaborative documents.
- Replacement removes the text positions that peers' cursors and future anchors point to; this is accepted and documented.
- Mixed legacy/collaborative writers are therefore serialized by the shared locks in the [global lock order](#lock-order) (both take the owner row for update) and detected by the hash.
- `contractBody` and `schemaSql` (≤100000 characters) stay single-field last-write-wins for now; extending the precondition to them is a separate decision.

### Stale and revoked clients

- Clients present their editor schema version during the handshake. A client older than the document's minimum is refused before its bindings run, because a strict editor schema deletes content it does not understand and that deletion would sync to everyone ([Tiptap collaborative-editing guide, Pitfalls](https://tiptap.dev/docs/hocuspocus/guides/collaborative-editing), research-brief source).
- On revoke or demotion, a client's offline or unsent local buffer is **never** resent until write eligibility is re-established. A stale read-only editor discards local divergence, loads fresh server state, and keeps its unsent changes quarantined with a visible recovery path (for example "copy my unsent text").
- On reconnect the UI distinguishes **durably acknowledged** (server committed revision) from **merely synced** (received by peers or the socket). "Saved" is shown only for the former.

## Proposed limits

This table is the **initial proposal, subject to `v0.2/durable-documents` measurement**, and this ADR is the single home for these numbers (backlog issue bodies reference it rather than copy it). Nothing is implemented. Frame and update caps are bytes; the mirror cap is characters.

| Limit | Proposal |
| --- | --- |
| Inbound frame (document sync) | 256 KiB; larger rejected without applying |
| Single update / SyncStep2 payload | 256 KiB |
| Encoded document state | 2 MiB per document (also the `CHECK` backstop) |
| Markdown mirror | 20000 characters (existing contract) |
| Awareness frame / per-client state | 4 KiB / 1 KiB |
| Resident documents per process | 500 |
| Peers per document | 25 (guests none writeable) |
| Sockets per user / per workspace / per guest address | 20 / 100 / 10 |
| Update rate per socket | 30 per second, burst 60 |
| Awareness rate per socket | 5 per second |
| Bytes per socket per second | 256 KiB |
| Idle document eviction | After last peer leaves and the last revision is committed |

- Backpressure: use Bun's per-socket send result and configured `backpressureLimit`; a socket that cannot drain is closed with 1013 rather than buffered without bound. `maxPayloadLength` is server-wide in Elysia/Bun, not per-route, so it is set low enough for the largest legitimate frame while the existing `live.ts` 256-byte wrapper does not apply to the new route. How Bun 1.3.14 closes on overflow (the research brief reported close code 1006) was not re-verified.
- Eviction never drops unflushed durable data: a dirty document is flushed first, and if the process is at its resident-document cap, new loads are refused (1013) rather than evicting dirty documents.
- Residual risk: a legitimate editor can still cost CPU within the caps, and many cheap sockets can still exhaust a single process. This design mitigates, and does not claim to eliminate, denial of service.
- **Guest address cap and proxies.** The per-address guest cap relies on `clientIp` in `auth.ts`. With `TRUST_PROXY=true` the first `X-Forwarded-For` entry is client-controlled unless the proxy overwrites the header. Self-hosting must require that the proxy overwrites (not appends to) `X-Forwarded-For`, or the server must use the rightmost trusted hop; otherwise the cap is bypassable. This follows the repository rule not to trust proxy headers without validation.
- **Single instance only.** Rooms, authorization fan-out, queues, and resident documents are in-process. PostgreSQL row locks serialize writes to a row, but they do **not** make the system safe for multiple API instances: instances would not see each other's peers, awareness, or pending broadcasts, and revocation closes only local sockets. Horizontal scale needs a separate decision. **Enforcement gate:** `docs/self-hosting.md` and deployment manifests must document `replicas: 1`, and the server must fail loudly when another instance is detected (mechanism to be designed, for example a session-level PostgreSQL advisory lock held for the process lifetime).
- Operations: the self-hosting proxy rule allows WebSocket upgrades on `/api/canvases/*/live` ([self-hosting](../self-hosting.md)); the new route needs its own proxy and docs update. Shutdown must flush dirty documents before closing sockets. Restart of the single instance interrupts all editing; clients reconnect and resync from committed state.

## Reuse by later releases

- **v0.3 contracts.** `v0.3/contract-sessions` reuses authorization and ephemeral awareness for section presence and a defined conflict flow (optimistic hash precondition with visible recovery). It does **not** merge OpenAPI or Protobuf source automatically; a text-level CRDT merge can produce invalid contract source.
- **v0.4 schemas.** Presence and conflict handling on `schemaSql` the same way; structural edits wait on stable table, column, and key IDs (`v0.4/schema-identity-layout`).
- **v0.5 comments.** Text anchors can use `Y.RelativePosition`, which requires the same Y.Doc type history to resolve. `Y.createAbsolutePositionFromRelativePosition` returns `null` when the position cannot be referenced or its type is deleted ([relative positions](https://docs.yjs.dev/api/relative-positions)). So wholesale Markdown import replacement, legacy-`PATCH` replacement, or re-bootstrapping orphans anchors and needs explicit recovery (orphaned comment with its quoted text, plus an import preview warning). Contract-section, table, column, and key anchors require stable IDs and orphan handling as separate backlog issues (`v0.3/contract-identity`, `v0.4/schema-identity-layout`, `v0.5/object-anchors`, `v0.5/text-anchors`).

## What the spike did not prove

The [spike](../spikes/2026-10-13-collaboration-sync.md) passed seven transport scenarios on Bun 1.3.14, Elysia 1.4.30, Yjs 13.6.33, y-protocols 1.0.7, and lib0 0.2.119, including rejection of reader `Update` and `SyncStep2` before apply. It used synthetic roles in an isolated room. It did **not** prove:

- real authentication, cookies, link-share guests, or the existing access guard
- per-frame and per-recipient authorization against PostgreSQL, or revoke races
- persistence, commit-before-ack ordering, failure recovery, or bootstrap
- TipTap binding, `@tiptap/y-tiptap` behavior, server-side headless schema/serializer under Bun, or Markdown round-trip fidelity
- browser behavior, offline buffers, schema-version gating, reconnect UX
- any of the proposed caps, decoder budgets, or load behavior
- the legacy `PATCH` precondition, undo exclusions, or tombstone/restore flow

## Release gates

Before any release claims collaborative documentation: the cross-canvas write-rule and #10/#26 and #12 prerequisites are merged; integration tests with an isolated PostgreSQL cover the access matrix (manager, editor, viewer, link guest, revoked, removed from workspace) for connect, receive, send, and awareness; concurrent two-connection revoke versus write; first-bootstrap races and delete races; commit-failure injection with no divergence; legacy `PATCH` 409 and mixed writers; backfill resume; decoder and cap tests including worker budget; golden Markdown fixtures including unsupported content; browser journeys for reconnect, demotion, and stale schema; a rollback rehearsal; plus the gates stated above: missing-Origin upgrade rejection, check ordering and rate-budget tests, awareness clientID spoofing, per-commit content validation, deleted text not recoverable from served state, the two-connection lock-order deadlock test (including two undos reaching one object through different canvases a no-op-walk test showing that candidates skipped or found a no-op in the walk take no share-class or update lock, and the regression test "takes no shared lock on an entity while walking past a skipped candidate to an older update of it" in `apps/api/tests/canvas-event-transaction.test.ts`), a test that `retryOnLockConflict` retries 40P01/40001 up to 3 attempts and then answers 503, the single-writer negative test, delete-undo un-tombstoning and re-projection from CRDT state, tombstone coverage of every delete and cascade path, and single-instance detection. These map to `v0.2/durable-documents`, `v0.2/sync-access`, `v0.2/coedit-presence`, `v0.2/markdown-fidelity`, and `v0.2/release-evidence` in the [backlog](../release-backlog.md). See [testing](../testing.md) for current checks.

## Sources

Fetched and read on 2026-10-13 unless noted.

- Yjs: [document updates](https://docs.yjs.dev/api/document-updates) (updates are `Uint8Array`, order-independent and idempotent; `Y.applyUpdate` accepts a transaction origin), [relative positions](https://docs.yjs.dev/api/relative-positions), [UndoManager](https://docs.yjs.dev/api/undo-manager), [y-protocols](https://github.com/yjs/y-protocols) (current README documents `@y/protocols`).
- Tiptap: [undo-redo extension](https://tiptap.dev/docs/editor/extensions/functionality/undo-redo), [configure / StarterKit `undoRedo`](https://tiptap.dev/docs/editor/getting-started/configure), [Hocuspocus hooks](https://tiptap.dev/docs/hocuspocus/server/hooks) (`beforeHandleMessage`, `beforeHandleAwareness`, `onChange`, debounced `onStoreDocument`, `connection.readOnly`).
- PostgreSQL 16: [explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html) (locks held to transaction end; long transactions discouraged), [INSERT](https://www.postgresql.org/docs/16/sql-insert.html) (`ON CONFLICT DO NOTHING`), [binary string functions](https://www.postgresql.org/docs/16/functions-binarystring.html) (`octet_length(bytea)`), [CREATE TRIGGER](https://www.postgresql.org/docs/16/sql-createtrigger.html) (foreign-key action deletes fire relevant triggers).
- npm registry metadata read 2026-10-13: `@hocuspocus/server`, `@hocuspocus/provider`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `@tiptap/y-tiptap`, `@tiptap/starter-kit`, `y-prosemirror` (license and peer dependencies).
- Not re-fetched, taken from the earlier research briefs and treated as leads: Hocuspocus issue 800 on multi-instance sync, the upstream Yjs update-size-limit pull request status, Bun overflow close-code behavior, Drizzle 0.44.7 lacking a `bytea` builder, and the Tiptap Cloud pricing/private-registry boundary.
