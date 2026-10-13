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

The API stores password hashes and hashed session tokens in PostgreSQL. Session cookies are HttpOnly and SameSite=Lax. For public HTTPS origins, production cookies are Secure. The WebSocket route uses the same origin and access rules as the canvas. The socket checks access again when it opens, before it joins the canvas room or receives presence. Until then it holds up to 16 incoming messages and drops the rest; if the check cannot run, the socket closes with code 1011 so the client retries. Open sockets are rechecked every 30 seconds. They are also rechecked at once after a sign-out, a password change, a system role change, a workspace member change, a canvas member change, a change to the canvas (including its sharing), and a canvas delete. Other changes, such as a workspace delete, are caught by the periodic recheck. A revoke (code 1008) and a recheck that cannot run (code 1011), whether periodic or immediate, take the same path: the socket is detached from the canvas room and from its pending state first, so it stops receiving and relaying messages, and is then closed. If the client does not finish the close handshake, the socket is terminated after one second (`terminateAfterMs`). A socket that is closing is never joined to the room, and its messages are ignored. If the lookup of a workspace's canvases fails during an immediate recheck, every connected socket is rechecked, so each one fails closed. The other sockets are still rechecked. The API `/health` route checks database connectivity.

## Canvas events and undo

Every change to a canvas writes a row to `canvas_events` in the same transaction as the change. If the event insert fails, the change rolls back. A transaction that records events locks the affected canvas rows first, in ascending id order, and then the entity, connection, and placement rows. Undo locks the canvas row before it touches any object. Undo judges each candidate on unlocked reads, so walking past no-op candidates holds no object lock. Only a candidate that needs a real write to a shared entity or connection (`entity.updated`, non-bend `connection.updated`) then takes that row `FOR UPDATE` and holds it to commit, the same order as the `PATCH` routes. It re-reads the row under the lock, re-checks the actor's write access and the no-op test, and refuses (a conflict skip) if edit access was lost while it waited, so undos that reach one object through different canvases run one after the other and neither overwrites the other. A candidate that becomes a no-op only after its lock was granted keeps that lock, so a rare deadlock stays possible: the undo route reruns the whole transaction on `40P01` or `40001` up to three times and then answers 503 (retryable), never 500. Deleting a shared entity or connection on undo locks the row before it checks whether another canvas still shows it, so a concurrent placement is kept instead of cascade-deleted. `recordCanvasEvent` also locks the event's canvas row itself, as a safety net for a writer that did not.

Events are ordered by `seq`, an identity column on `canvas_events` (migrations `0006` and `0007`). The writer holds the canvas lock when `seq` is allocated, so within a canvas a later event always has a higher `seq`. `created_at` is the database clock at transaction start and can step back, so neither undo nor the feed relies on it. Undo walks the canvas's events from the highest `seq` down.

`entity.updated` and `connection.updated` events write version 2 metadata. `previous` holds only the top-level fields the request named. `previousMetadata` holds one entry per metadata key the request named: `{ "present": false }` when the key did not exist, or `{ "present": true, "value": ... }` when it did, including a `null` value.

```json
{
  "version": 2,
  "fields": ["name", "metadata"],
  "previous": { "name": "Orders API" },
  "previousMetadata": {
    "owner": { "present": true, "value": "payments" },
    "tier": { "present": false }
  }
}
```

Undoing this event sets `name` back and restores `owner`. It deletes `tier`, and leaves every other field and metadata key as it is. Events without a `version` are legacy events. Undo restores their full previous snapshot, except that metadata keys registered as externally managed keep their current values.

Before it reverses an event, undo checks the actor's current right with the transaction's own view of the data. Undoing `canvas.updated` needs the canvas manager role, the same rule as the canvas `PATCH` route. Undoing `entity.updated` or a non-bend `connection.updated` needs the same write access to the object as the entity or connection `PATCH` route (`objectAccess`). A candidate that fails the check is skipped like a conflict, with reason `conflict`, and is not marked undone. No extra check runs for the other actions (see `undoAuthorized`): bend, placement, and auto-neat undos only touch this canvas, whose route already requires a role above viewer; undoing a create only deletes rows no other canvas places; and undoing a delete only inserts missing rows and this canvas's placements and links, so rows other canvases show are never overwritten.

Undo skips an event, and reports it as a conflict, when someone else changed the same objects after it. Two version 2 edits of one object conflict only when they touch the same field or the same metadata key. For every other event the unit of conflict is the object. Externally managed metadata keys never count toward a conflict.

The activity feed returns metadata to every reader through an allowlist (`ACTIVITY_METADATA_ALLOWLIST` in `apps/api/src/modules/canvas/activity.ts`). Only listed keys with a scalar value, or a list of strings, are sent. Payload keys such as `previous`, `previousMetadata`, `snapshot`, and `hooks` are never sent, because they hold historical content. Undo reads the stored row, not the feed. `skipped` is not on the allowlist. The `canvasEventSchema` contract accepts only `string`, `number`, `boolean`, `null`, or `string[]` metadata values.

A transaction that changes an object shown on several canvases locks all of them (`withCanvasLocks`). If the set of canvases showing the object changes while it waits for the locks, it retries. After five attempts the request fails with 503 (`CanvasLockContention`), and the client can try again.

`apps/api/src/modules/canvas/undo-registry.ts` is the extension point for subsystems that need to take part in undo. These are future collaboration and comments features: no such subsystem exists yet, and only `canvas.undo` is registered by default. Registrations are process-local, so register them at startup on every API instance. An instance without a registration silently skips capture and restore. Each `register*` function returns a function that removes only that registration.

- `registerNonReversibleAction(action)` marks an action as a historical record that undo walks past. `canvas.undo` is registered by default and cannot be removed. `listNonReversibleActions()` returns the set.
- `registerExternalMetadataKey(key)` declares a metadata key owned by another subsystem. Undo neither restores nor deletes it. `isExternalMetadataKey(key)` reports it. Namespace external keys, for example `comments.threadIds`.
- `registerDeleteUndoHook(hook)` registers a `DeleteUndoHook` (`name`, `snapshot`, `restore`). A hook with the same name is replaced. `captureDeleteHooks` runs each `snapshot(tx, target)` inside the delete transaction, before the rows are deleted, and a delete event stores the result under metadata `hooks` when it is not empty. A snapshot must be JSON-serialisable, and `undefined` stores nothing. `restoreDeleteHooks` hands each stored entry back to the hook of the same name inside the undo transaction, after the graph rows are restored. `restore` must be idempotent; if it throws, the whole undo is rolled back. Entries for unknown hook names are ignored. `target` is a `DeleteUndoTarget`: `kind` is `entity` or `connection`, and `ids` lists the removed ids. For an entity delete, `ids` include the deleted subtree.

Update events carry `version: UPDATE_EVENT_METADATA_VERSION` (2) from `apps/api/src/modules/canvas/event-metadata.ts`. Undo treats metadata as version 2 only when `fields`, `previous`, and `previousMetadata` have the complete shape; otherwise it handles the event as a legacy event.

## State ownership

TanStack Query owns data fetched from the API. Zustand holds transient editor state such as selection. The browser does not treat XYFlow node data as the database record. Changes are persisted through the API, and other open canvases receive update notifications over WebSocket.

## Source of truth

This document describes the current codebase. Before changing a data contract, inspect `packages/domain`, `packages/contracts`, `packages/db`, the API route, and the web consumer together.
