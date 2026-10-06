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
  - There is no co-editing or presence yet. If two people edit the same documentation, the last save wins.
  - Images, footnotes, YAML front matter, and raw HTML are not supported as blocks. Documents containing them open in Markdown source mode with a warning so editing preserves their source. A paste containing unsupported Markdown is stopped with a warning; choose **Edit Markdown source** and paste again. Source mode is also available for supported documents, and **Edit as blocks** returns to the block editor once the source has nothing it would lose. Code examples and `<br>` remain supported in blocks.
  - A Markdown file cannot be imported yet; paste its contents instead.
  - Documentation is limited to 20,000 characters of Markdown. Longer documentation is not saved, and text over the limit is lost if the dialog is closed before it is shortened.
  - A table cell holds text only, as in Markdown: lists, headings, and other blocks cannot be placed in a cell.
- **Consistent interface:** tighten visual patterns and interaction behavior across the canvas, inspector, dialogs, and supporting pages; the first focused stability and usability pass is planned for `v0.6.0`.
- **API and protobuf contracts:** go beyond basic manual fields to represent, edit, and inspect contracts properly; consider OpenAPI and protobuf import or synchronization.
- **Database diagrams:** provide a dedicated view of schemas and relationships, building on the existing schema fields.
- **External sources:** explore synchronization with databases, repositories, and deployment systems where it helps keep the model accurate.

Product proposals should preserve the core rule: the semantic architecture model is the source of truth, and the canvas is one view of it. Discuss user journeys and data ownership before choosing a diagram or integration format.
