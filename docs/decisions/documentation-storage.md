# Documentation storage: Markdown first, collaboration later

Status: interim implementation decision; local follow-up issue draft, not a published issue.

The v0.2.0 roadmap asks for a collaborative document representation before replacing the Markdown field. The first block-editor increment deliberately keeps that field and its API contract. TipTap / ProseMirror is the editing UI, and its JSON document is temporary browser state. This increment does not implement a shared collaborative document or claim conflict-free editing: updates remain last-write-wins.

Markdown-first keeps existing API consumers, entity reading pages, exports, and activity history compatible. It also limits the editor to constructs that can be saved as Markdown. Opening, focusing, or moving the cursor must not canonicalize or save a document. Only an actual edit schedules a write; supported block syntax may then be normalized. Tables use compact rows and plain URLs remain plain to avoid artificial length growth. Unsupported images, footnotes, YAML front matter, and raw HTML use source editing with a warning instead of silent conversion. No database field or migration changes in this increment.

## Follow-up issue draft: choose the collaborative representation

Before replacing Markdown storage:

- Choose and document the collaborative representation, persistence, synchronization, access control, history, and migration strategy. Evaluate Yjs with realistic concurrent editing and recovery tests.
- If Yjs is adopted, treat Markdown as an import/export format and define the treatment of unsupported constructs. Preserve existing Markdown during migration and prove import/export fidelity.
- Disable StarterKit `undoRedo` when enabling the TipTap collaboration extension. Collaborative history must use Yjs-aware undo rather than two competing undo managers.
- Define how document history relates to canvas activity and canvas undo; test concurrent changes, stale clients, access revocation, reconnects, and migration rollback in isolation.
- Update the roadmap and accepted issue with the chosen representation before changing the persisted field.

This file makes the interim decision reviewable locally. Publishing an issue or changing the storage model remains a separate authorized action.
