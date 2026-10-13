# Architecture and tech stack

Wooble is a TypeScript monorepo managed with Bun workspaces and Turborepo. The web app, API, and PostgreSQL database form the runtime. [Self-hosting](self-hosting.md) describes their deployment boundary.

| Area | Current implementation | Purpose |
| --- | --- | --- |
| Web | React, Vite, TanStack Router and Query | UI, routing, server state |
| Documentation | TipTap / ProseMirror, Markdown | Lazy-loaded block editor with source fallback; Markdown persistence |
| Canvas | XYFlow, Zustand | Graph interaction and transient editor state |
| UI | Tailwind CSS, Radix primitives, shared tokens | Interface components and visual system |
| API | Elysia on Bun | HTTP and WebSocket routes |
| Validation | Zod contracts | Request and model validation |
| Database | PostgreSQL, Drizzle | Persistent model, access, activity, and migrations |
| Tooling | Bun, Turborepo, TypeScript, Biome | Install, build, type checking, lint, formatting |

## Packages

```text
apps/web        browser application
apps/api        Elysia API and WebSocket server
packages/domain     architecture types
packages/contracts  Zod contracts
packages/db         Drizzle schema, migrations, and example seed
packages/ui         shared visual tokens
```

Application code depends on shared packages. Domain entities and connections remain separate from XYFlow's rendering objects. `entities` and `connections` store architecture meaning; `canvas_nodes` and `canvas_connections` determine what is shown and where. A canvas graph response combines both layers for the frontend.

## Data and access

Registration creates a personal workspace. Workspace managers manage members and canvases; canvas editors can change a shared canvas; viewers can inspect it. A canvas shared by link can be read without an account. The API checks access at the registered route and scopes reads to the relevant workspace or canvas.

The API stores password hashes and hashed session tokens in PostgreSQL. Session cookies are HttpOnly and SameSite=Lax. For public HTTPS origins, production cookies are Secure. The WebSocket route uses the same origin and access rules as the canvas. The API `/health` route checks database connectivity.

## State ownership

TanStack Query owns data fetched from the API. Zustand holds transient editor state such as selection. The browser does not treat XYFlow node data as the database record. Changes are persisted through the API, and other open canvases receive update notifications over WebSocket.

## Documentation storage

The documentation editor and its autosave lifecycle load together in a separate browser chunk. The API continues to store Markdown strings; TipTap JSON is transient editor state. Compact tables and bare URLs avoid expanding documents toward the 20,000-character contract limit. Documents with images, footnotes, YAML front matter, or raw HTML open as Markdown source with a warning; unsupported Markdown paste is stopped before conversion and offers source editing. Code examples and supported `<br>` breaks remain editable as blocks.

The [Markdown-first decision and collaboration follow-up](decisions/documentation-storage.md) records the interim scope and the checks required before adopting Yjs.

## Source of truth

This document describes the current codebase. Before changing a data contract, inspect `packages/domain`, `packages/contracts`, `packages/db`, the API route, and the web consumer together.
