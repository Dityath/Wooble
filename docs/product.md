# What Wooble is

Wooble is an interactive software architecture canvas for anyone who needs to design, understand, document, or discuss a system and the contracts between its parts. Individuals and teams can sketch an architecture early, then keep its technical context connected as the system changes. People can start from an overview and open implementation detail when they need it.

## The problem

Architecture knowledge often becomes scattered across diagrams, README files, API specifications, database tools, and conversations. A diagram may remain attractive after its service names or dependencies have changed. Wooble gives systems, services, databases, and connections stable identities, then displays them on a canvas.

## How it works

1. **Canvas library:** choose an architecture view.
2. **Architecture canvas:** read system boundaries, components, and typed connections; pan, zoom, move nodes, and collaborate.
3. **Inspector and details:** select a node or connection to inspect its metadata, documentation, contract, or database information while keeping the canvas in view.

An architecture entity can appear on more than one canvas. Its identity and metadata belong to the model; each canvas stores its own placement. Connections are model objects with source, target, type, and metadata, rather than labels drawn on a line.

## Current capabilities

The repository contains workspace and canvas access control, password accounts, invitation links, link-shared read-only canvases, live canvas presence, a canvas activity log with undo, architecture editing, technology metadata, basic manual contract fields, database schema editing, and a block documentation editor for nodes and connections. In the documentation editor, typing `/` opens a keyboard-operable menu that inserts headings, lists, task lists, quotes, code blocks, dividers, and tables; pasted Markdown is converted into blocks; and changes save automatically shortly after typing stops, when the editor loses focus, or when the dialog closes. The [interim storage decision](decisions/documentation-storage.md) keeps Markdown first and defers Yjs collaboration. Documentation is still stored as Markdown, which the entity page and read-only viewers display as before. PostgreSQL stores the model and canvas layout. The [README](../README.md) explains the current development setup; [self-hosting](self-hosting.md) covers Docker and Bun.

## Areas to improve

The initial release sequence, target dates, and criteria of done for the first four directions are in the [product roadmap](roadmap.md). Dates are revisable targets, and these entries do not claim the features already exist:

- **Comments and discussion:** let people discuss an architecture element or connection in its context.
- **Collaborative documentation:** make documentation more useful and let members contribute, review, and maintain it together. The block editor is the first step. It currently has these known limits:
  - There is no co-editing or presence yet, and no CRDT or Yjs. Co-editing is last-write-wins: if two people edit the same documentation, the later save replaces the earlier one without merging, so an edit can overwrite a concurrent one.
  - Images, footnotes, YAML front matter, and raw HTML are not supported as blocks. Documents containing them open in Markdown source mode with a warning so editing preserves their source. A paste containing unsupported Markdown is stopped with a warning; choose **Edit Markdown source** and paste again. Source mode is also available for supported documents, and **Edit as blocks** returns to the block editor once the source has nothing it would lose. Code examples and `<br>` remain supported in blocks.
  - A Markdown file cannot be imported; `.md` file import is not available, so paste its contents instead.
  - Documentation is stored as Markdown and limited to 20,000 characters. Longer documentation is not saved. The editor shows how many characters to remove and offers no Retry, because saving the same text again cannot succeed. The text over the limit is kept only as an unsaved draft in this browser (see below), not on the server.
  - Unsaved drafts live only in this browser on this device. They are not synced to other devices or browsers, are not shared between open tabs in real time (a second tab can keep writing until its next request fails), are lost when browser data is cleared, and expire after 7 days. Drafts are kept per user. Signing out or changing the password first suspends draft writes and then removes all documentation drafts on this device. Signing in resumes drafts and removes expired drafts and other users' drafts on the device, so a shared browser does not keep someone else's text. A session that simply expires keeps that user's draft until the next sign-in by anyone; if a different user signs in, it is removed.
  - A draft is never inserted automatically: the editor asks whether to **Restore** or **Discard saved copy**, and editing stays blocked until you decide. If you typed before the access check finished, your new text stays in the editor and the older draft is still offered: Restore puts the older draft above your new text, Discard keeps only your new text. Deleting all documentation is kept as a draft too, so a failed save followed by a reload offers to restore the deletion. A draft is offered only after your account is known and a canvas-access check made after the editor opened says you are an editor or manager.
  - Edits typed in the autosave window just before signing out can be lost, because sign-out removes the drafts on this device and the pending save may not have completed.
  - A save rejected because access was removed (403) keeps the editor visible but read-only with the text you typed, so you can copy it. There is no Retry, the draft is removed, and the next step is to ask a canvas manager for edit access. If the session ended (401), the text is kept on this device and you choose Retry after signing in again. Other client errors, such as 404, 409, 410, or 413 (anything 4xx except 408 and 429), are permanent: the text is kept and can be edited, but there is no Retry because saving the same text cannot succeed. Timeouts and rate limits (408, 429), server errors, and network failures are treated as temporary and offer Retry.
  - The browser warns before a page unload while changes are unsaved. Closing the details dialog with the close button, by clicking the overlay, or with Escape while documentation is unsaved asks for confirmation with **Keep editing** or **Close anyway**; the text is saved when possible and otherwise kept on this device.
  - If the editor's code fails to load (offline, or a new deployment replaced it), the documentation is shown as readable Markdown with a **Reload** button. The editor cannot be retried in place, because Chromium remembers a failed dynamic import until the page is reloaded.
  - Only `http`, `https`, `mailto`, and relative links are active in the editor and the reader. Links with other schemes, such as `javascript:` or `data:`, are refused.
  - Viewers and signed-out link guests can read connection documentation, read-only, and cannot edit it.
  - A table cell holds text only, as in Markdown: lists, headings, and other blocks cannot be placed in a cell.
- **Consistent interface:** tighten visual patterns and interaction behavior across the canvas, inspector, dialogs, and supporting pages; the first focused stability and usability pass is planned for `v0.6.0`.
- **API and protobuf contracts:** go beyond basic manual fields to represent, edit, and inspect contracts properly; consider OpenAPI and protobuf import or synchronization.
- **Database diagrams:** provide a dedicated view of schemas and relationships, building on the existing schema fields.
- **External sources:** explore synchronization with databases, repositories, and deployment systems where it helps keep the model accurate.

Product proposals should preserve the core rule: the semantic architecture model is the source of truth, and the canvas is one view of it. Discuss user journeys and data ownership before choosing a diagram or integration format.
