# Documentation storage: Markdown first, collaboration later

Status: interim implementation decision; local follow-up issue draft, not a published issue.

The v0.2.0 roadmap asks for a collaborative document representation before replacing the Markdown field. The first block-editor increment deliberately keeps that field and its API contract. TipTap / ProseMirror is the editing UI, and its JSON document is temporary browser state. This increment does not implement a shared collaborative document or claim conflict-free editing: updates remain last-write-wins.

Markdown-first keeps existing API consumers, entity reading pages, exports, and activity history compatible. It also limits the editor to constructs that can be saved as Markdown. Opening, focusing, or moving the cursor must not canonicalize or save a document. Only an actual edit schedules a write; supported block syntax may then be normalized. Tables use compact rows and plain URLs remain plain to avoid artificial length growth. Unsupported images, footnotes, YAML front matter, and raw HTML use source editing with a warning instead of silent conversion. No database field or migration changes in this increment.

## 2026-10-13: Unsaved drafts

Context: a reload, a crashed tab, a rejected save, or a lost session could destroy documentation that was typed but not saved. The Markdown field and API contract are unchanged by this decision.

Options considered:

- **`localStorage`:** synchronous, survives reloads and restarts, scoped to the origin, and already the app's only client storage pattern (`lib/use-appearance.ts`).
- **`sessionStorage`:** lost when the tab closes, which is exactly when a draft is most useful.
- **IndexedDB:** larger quota, but asynchronous and heavier than 20,000-character Markdown strings need.
- **Server-side drafts:** would sync across devices, but needs a schema, migration, API and access rules for text the server may be rejecting. Deferred with the collaborative representation.

Decision: `localStorage`, under the key `wooble:draft:v1:<userId>:<kind>:<objectId>`, with each segment URI-encoded. The user is in the key so another account on a shared browser never sees a draft; kind (`entity` or `connection`) is in it because entities and connections share the documentation field but not ids; the object id keeps drafts apart per object. Encoding stops an id containing `:` from forging another key. The `v1` prefix lets a later shape change migrate rather than misread. Drafts expire after 7 days.

When drafts are written and cleared:

- A draft is written when the editor holds unsaved text, including text over the 20,000-character limit, and when the editor closes with an unsaved edit. A blank draft removes the entry.
- It is cleared when that exact text saves, when the user discards it, when it matches the saved text, or when a save returns 403.
- A 401, any other 4xx (such as 400, 404, 409, 410, 413, or 422), and network or server errors keep the draft. Only 408, 429, 5xx, and network failures are treated as transient and offer Retry; a 401 also offers a manual Retry once the user has signed in again, and other 4xx responses are permanent, so they offer no Retry.
- Sign-out and a password change first suspend draft reads and writes, then remove every documentation draft on the device. Suspension keeps an editor that is still mounted from writing its text back after the purge. Signing in resumes drafts and removes expired drafts and drafts of other users on the device, the shared-device sweep. A session that merely expires keeps that user's draft until the next sign-in by anyone, which removes it if a different user signs in.
- Reads and writes never throw: a full or blocked store only costs the draft.

Recovery is explicit. The editor offers the draft with Restore and Discard and never injects it, so a stale draft cannot silently overwrite newer saved text. The prompt must be decided before editing continues: the editor is read-only until the user chooses Restore or Discard saved copy. It is offered only after `me` has resolved and a canvas-access check made after the editor mounted says the role is editor or manager, because the key depends on the user, a cached role may be stale, and a viewer must not be offered an edit.

A 403 clears the draft because access was removed deliberately: keeping text the user may no longer write would resurface it later in an editor they cannot use. The editor stays visible and read-only with the typed text so the user can copy it, offers no Retry, and says to ask a canvas manager for edit access. A 401 keeps the draft because the same user can sign in again and save.

Closing the details dialog with unsaved documentation, by the close button, the overlay, or Escape, asks for confirmation with Keep editing or Close anyway. The text is saved when possible and otherwise kept on this device. If the lazily loaded editor chunk fails to load, the documentation is shown as readable Markdown with a Reload button, because a failed dynamic import cannot be retried in place in Chromium.

Limits: drafts are per browser and device, are removed by clearing browser data, and are not synced. They are not shared between tabs in real time: a second open tab can keep writing until its next request fails. They expire after 7 days. Edits made in the autosave window right before sign-out can be lost. This does not add co-editing; updates remain last-write-wins.

The server remains the source of truth for authorization. A draft is client-held text, not permission; every save is checked by the API against the current role, and the client never uses a stored draft to decide who may write.

## Follow-up issue draft: choose the collaborative representation

Before replacing Markdown storage:

- Choose and document the collaborative representation, persistence, synchronization, access control, history, and migration strategy. Evaluate Yjs with realistic concurrent editing and recovery tests.
- If Yjs is adopted, treat Markdown as an import/export format and define the treatment of unsupported constructs. Preserve existing Markdown during migration and prove import/export fidelity.
- Disable StarterKit `undoRedo` when enabling the TipTap collaboration extension. Collaborative history must use Yjs-aware undo rather than two competing undo managers.
- Define how document history relates to canvas activity and canvas undo; test concurrent changes, stale clients, access revocation, reconnects, and migration rollback in isolation.
- Update the roadmap and accepted issue with the chosen representation before changing the persisted field.

This file makes the interim decision reviewable locally. Publishing an issue or changing the storage model remains a separate authorized action.
