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

`accessGuard` in `apps/api/src/lib/auth.ts` gives every registered route an access class and denies requests to an API route without one. A route nested under a workspace, canvas, entity, or connection follows the rule of that resource. Workspace managers and system admins can read and write an entity or connection. Otherwise, reading it needs a role on a canvas of its workspace that shows it, or such a canvas shared by link; writing it needs the editor role on every such canvas. Without an account, only a link-shared canvas (its details, graph, access role, and live socket) and an entity it shows, requested with `?canvasId=`, can be read.

The API stores password hashes and hashed session tokens in PostgreSQL. Session cookies are HttpOnly and SameSite=Lax. For public HTTPS origins, production cookies are Secure. The WebSocket route uses the same origin and access rules as the canvas. The socket checks access again when it opens, before it joins the canvas room or receives presence. Until then it holds up to 16 incoming messages and drops the rest; if the check cannot run, the socket closes with code 1011 so the client retries. Open sockets are rechecked every 30 seconds, and at once after a sign-out, a password change, a system role change, a workspace or canvas member change, and when the canvas sharing changes or the canvas is deleted. A socket that lost access closes with code 1008. The API `/health` route checks database connectivity.

## State ownership

TanStack Query owns data fetched from the API. Zustand holds transient editor state such as selection. The browser does not treat XYFlow node data as the database record. Changes are persisted through the API, and other open canvases receive update notifications over WebSocket.

## Source of truth

This document describes the current codebase. Before changing a data contract, inspect `packages/domain`, `packages/contracts`, `packages/db`, the API route, and the web consumer together.
