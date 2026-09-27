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

The repository contains workspace and canvas access control, password accounts, invitation links, link-shared read-only canvases, live canvas presence, a canvas activity log with undo, architecture editing, technology metadata, basic manual contract fields, and database schema editing. PostgreSQL stores the model and canvas layout. The [README](../README.md) explains the current development setup; [self-hosting](self-hosting.md) covers Docker and Bun.

## Areas to improve

These are product directions, not promises that the features already exist or are scheduled for a particular release:

- **Comments and discussion:** let people discuss an architecture element or connection in its context.
- **Collaborative documentation:** make documentation more useful and let members contribute, review, and maintain it together. Current documentation fields are basic.
- **Consistent interface:** tighten visual patterns and interaction behavior across the canvas, inspector, dialogs, and supporting pages.
- **API and protobuf contracts:** go beyond basic manual fields to represent, edit, and inspect contracts properly; consider OpenAPI and protobuf import or synchronization.
- **Database diagrams:** provide a dedicated view of schemas and relationships, building on the existing schema fields.
- **External sources:** explore synchronization with databases, repositories, and deployment systems where it helps keep the model accurate.

Product proposals should preserve the core rule: the semantic architecture model is the source of truth, and the canvas is one view of it. Discuss user journeys and data ownership before choosing a diagram or integration format.
