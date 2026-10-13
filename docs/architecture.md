# Architecture and tech stack

Wooble is a TypeScript monorepo managed with Bun workspaces and Turborepo. The web app, API, and PostgreSQL database form the runtime. [Self-hosting](self-hosting.md) describes their deployment boundary.

| Area | Current implementation | Purpose |
| --- | --- | --- |
| Web | React, Vite, TanStack Router and Query | UI, routing, server state |
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

## Activity and undo

Every canvas change writes a `canvas_events` row in the same transaction as the change, so a change never commits without its history. Writers lock the canvas rows that show the changed object in id order, then the object, and stamp the event with `clock_timestamp()` while holding those locks. A canvas's events are therefore in commit order. An edit to an entity or connection is recorded on every canvas that shows it.

Undo (`apps/api/src/modules/canvas/undo.ts`) locks the canvas, then walks the actor's own events newest first. It skips an event when a later event by another actor touched the same object, or the same field for updates, and reports it as a conflict. An update event stores the changed fields, the changed metadata keys, and only their previous values. Undo restores exactly those, so undoing a rename leaves later documentation, contract, or schema edits alone. Events written before field-scoped undo list the requested fields but not the metadata keys. For those, undo restores the listed top-level fields and the metadata keys whose current value differs from the stored snapshot, and any later metadata change by a collaborator makes the event a conflict.

Features can register with the undo module: actions that are never undone and block older undos of the same objects, metadata keys that canvas undo never restores, and hooks that snapshot and restore their own rows when an entity subtree or connection delete is undone.

The activity feed returns a per-action summary of each event, such as changed field names or counts. It never returns previous values or delete snapshots, because any reader of the canvas can read the feed.

## State ownership

TanStack Query owns data fetched from the API. Zustand holds transient editor state such as selection. The browser does not treat XYFlow node data as the database record. Changes are persisted through the API, and other open canvases receive update notifications over WebSocket.

## Source of truth

This document describes the current codebase. Before changing a data contract, inspect `packages/domain`, `packages/contracts`, `packages/db`, the API route, and the web consumer together.
