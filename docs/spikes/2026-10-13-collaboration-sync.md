# Collaboration transport spike: Yjs 13 over Elysia binary WebSockets

Date: 2026-10-13. **Result: all seven bounded transport scenarios passed,
including two actual reruns. This is evidence, not a production implementation or an ADR.**

## Isolation and restart inventory

- Repository file: `<repo>/docs/spikes/2026-10-13-collaboration-sync.md`.
  This document is the only repository file owned/changed by this task. No repository
  package manifest, lockfile, application source, test, migration, or database was changed.
- Requested sandbox was absent. Created and preserved
  `$SPIKE_DIR`, an external temporary directory.
- A previous, differently named sandbox, `wooble-p1-4-spike` beside it, existed
  with `package.json`, `bun.lock`, `src/client.ts`, `src/server.ts`, and `tests/`.
  Its directory and manifest were inspected, but none of its files were modified,
  deleted, executed, or relied upon as test evidence.
- Initial `git status --short`: `?? docs/release-backlog.md`. That file belongs to
  the release backlog work and was preserved. No commit, GitHub write, or package publication.
- `bun --version` returned **1.3.14**, matching the root `packageManager` and `bun.lock`.
  Platform: **darwin/arm64**. Repository `bun.lock` resolves Elysia to **1.4.30**,
  despite `apps/api/package.json` specifying `^1.4.30`; this spike pins the resolved version.
- Initial `lsof -nP -iTCP:41424 -sTCP:LISTEN` returned no listener. The spike binds
  **127.0.0.1:41424**, with `reusePort: false`; it does not connect to an existing server.
  Its `finally` block stops its own server and destroys every document/awareness timer.
- Existing `apps/api/src/lib/live.ts` and `apps/api/src/app.ts` were read for the
  registered WebSocket pattern, role/access separation, binary boundary concerns,
  and shutdown conventions. This isolated room intentionally imports no application
  auth, DB, or canvas model code.

## Consulted official sources and protocol decisions

1. [Yjs document updates](https://docs.yjs.dev/api/document-updates): binary
   `Uint8Array` updates, state vectors, commutative/idempotent application, and transaction
   origins. Local client updates are forwarded; received updates use a distinct origin
   to prevent echo loops. The server broadcasts applied incremental updates.
2. [Official y-protocols repository](https://github.com/yjs/y-protocols): consulted,
   but its current default-branch README now describes `@y/protocols`. **Do not copy
   those current import names into this Yjs-13 spike.** Installed `y-protocols@1.0.7`
   `sync.js`/`awareness.js` and its registry metadata are the version-specific evidence.
   Its peer dependency is `yjs: ^13.0.0`. No Yjs 14 beta or `@y/websocket-server` is used.
3. [Elysia WebSockets](https://elysiajs.com/patterns/websocket): registered `.ws`
   route, route params validation, lifecycle callbacks, JSON parsing behavior, and Bun
   WebSocket limits. Installed `elysia/dist/ws/index.mjs` lines 43–46 show that
   `ElysiaWS.send()` JSON-stringifies non-Buffer objects, including plain `Uint8Array`.
   Line 31 exposes `sendBinary` bound to Bun's raw socket. All spike server frames use
   **`socket.sendBinary(bytes)`**, and handlers return `undefined` (no auto-serialized reply).
   This is pinned implementation inspection; no separate failing `.send()` probe was run.
4. [Bun server/client WebSockets](https://bun.com/docs/runtime/http/websockets):
   native client `WebSocket`, binary sends, payload caps, backpressure configuration,
   and lifecycle. Every client sets `binaryType = "arraybuffer"` and asserts every
   server message is an **ArrayBuffer**, not a string/JSON. The server requires incoming
   messages to be **Uint8Array** before protocol processing. Native client sends use
   `Uint8Array`, with no Base64 or JSON wrapper.

Wire format for one message per WebSocket frame:

| Layer | varUint tag | Payload |
| --- | --- | --- |
| Outer | `0` = sync | inner tag plus varUint-length binary payload |
| Outer | `1` = awareness | varUint-length encoded awareness update |
| Inner sync | `0` = SyncStep1 | encoded state vector |
| Inner sync | `1` = SyncStep2 | encoded document update (can mutate content) |
| Inner sync | `2` = Update | encoded incremental document update |

Editors exchange Step1/Step2 in both directions on connect, so retained offline edits
are uploaded as well as missing server state downloaded. Readers request server state
with Step1 but do not get a server-initiated Step1. **The server reads the inner tag and
checks its synthetic role before decoding/applying BOTH Step2 and Update.** Calling
`readSyncMessage` and checking the returned type afterwards would be too late; the
installed helper already applies both variants. This implementation uses protocol
writers and explicit gated parsing/application instead.

## Exact dependencies and license audit

Before installation, the three requested Yjs-related versions were independently
queried at the exact-version npm registry URLs below. After `bun install`, `audit.mjs`
independently fetched all four exact-version registry records, compared installed
`package.json` versions and license fields, and checked the installed LICENSE texts
for the MIT grant and warranty disclaimer. It passed on both audit executions.

| Package | Exact installed version | License | Registry metadata / tarball source |
| --- | --- | --- | --- |
| Elysia | `1.4.30` | MIT | [record](https://registry.npmjs.org/elysia/1.4.30), [tarball](https://registry.npmjs.org/elysia/-/elysia-1.4.30.tgz) |
| Yjs | `13.6.33` | MIT | [record](https://registry.npmjs.org/yjs/13.6.33), [tarball](https://registry.npmjs.org/yjs/-/yjs-13.6.33.tgz) |
| y-protocols | `1.0.7` | MIT | [record](https://registry.npmjs.org/y-protocols/1.0.7), [tarball](https://registry.npmjs.org/y-protocols/-/y-protocols-1.0.7.tgz) |
| lib0 | `0.2.119` | MIT | [record](https://registry.npmjs.org/lib0/0.2.119), [tarball](https://registry.npmjs.org/lib0/-/lib0-0.2.119.tgz) |

Installed license source files and SHA-256 of their complete bytes (audit output):

```text
node_modules/elysia/LICENSE       139c2b5b5370aaf2bc08f0ef98bd90984c01ecec9448a6f93297f8ee28d2c938
node_modules/yjs/LICENSE          341baa53605ed85d6f95782322854cca56c655ebc7fd4712649b8e7afc6020ff
node_modules/y-protocols/LICENSE  5446db1e43fe52faf3faab7e9959fe3762ac11bdc61c0945934c498affd52d73
node_modules/lib0/LICENSE         5446db1e43fe52faf3faab7e9959fe3762ac11bdc61c0945934c498affd52d73
PASS installed versions, registry metadata, and MIT license texts
```

Repository sources reported by installed metadata: `github.com/elysiajs/elysia`,
`github.com/yjs/yjs`, `github.com/yjs/y-protocols`, and `github.com/dmonad/lib0`.
The complete sandbox lockfile below records tarball integrity for direct and transitive
packages. Bun installed 21 packages, including auto-resolved Elysia peers. This is a
direct-dependency license/text audit, **not** a transitive license/security audit or
cryptographic registry-signature verification. No license conclusions about production
distribution, existing repository licenses, or Bun's binary are implied.

## Commands and actual results

Executed in the sandbox, with Bun 1.3.14:

```sh
bun install
bun run audit
bun run test
# Actual second test and audit executions, followed by lock consistency check:
bun run test && bun run audit && bun install --frozen-lockfile
# Third test execution, after checking that documentation fences equal source:
bun verify-evidence.mjs <repo>/docs/spikes/2026-10-13-collaboration-sync.md && bun run test
```

Installation output: `elysia@1.4.30`, `lib0@0.2.119`, `y-protocols@1.0.7`,
`yjs@13.6.33`; `21 packages installed`. Frozen install output:
`Checked 21 installs across 22 packages (no changes)`.

One orchestration attempt supplied a mistyped sandbox working directory and failed
with `NotFound: FileSystem.access` **before executing any command**. The path was
corrected and the second execution above actually ran. Neither runtime test failed.

All three test executions exited 0 and produced this same output:

```text
$ bun spike.mjs
runtime bun 1.3.14; Elysia localhost:41424; cap=4096
PASS two editors: native binary send/receive; text=seed
PASS late-joining reader: SyncStep1/SyncStep2 catches up
PASS reader Update + content-bearing SyncStep2 blocked; byte-identical server state after EACH; receives editor updates
PASS concurrent disconnected edits + reconnect: all text/state vectors converge; text=seed-online-A-B
PASS second disconnect/reconnect recovers missed editor update
PASS awareness: server identity/clock, whitelisted fields, spoofed ID ignored; close removes/broadcasts presence
PASS negatives: 4097-byte frame, truncated/unknown/malformed messages and text rejected; unchanged state, next valid update works
METRICS {"binaryIn":23,"binaryOut":30,"rejectedUpdate":1,"rejectedStep2":1,"oversized":1,"malformed":4,"nonbinary":1,"awarenessSanitized":1,"awarenessRemoved":1}
CLIENT_BINARY [{"client":"a","in":11,"out":8},{"client":"b","in":11,"out":12},{"client":"r","in":8,"out":3}]
PASS all 7 scenarios
STOP own listener 41424; documents/awareness destroyed
```

Repository checks (Markdown-only repository change; no TypeScript change/typecheck):

```text
$ bun run lint
$ biome lint --error-on-warnings .
Checked 142 files in 157ms. No fixes applied.
$ bun run format:check
$ biome format .
Checked 164 files in 44ms. No fixes applied.
```

`verify-evidence.mjs` compares each complete file fence byte-for-byte with sandbox
source (including the lockfile), and prints SHA-256. Thus the source embedded here is
the source actually executed, not a hand-waved reconstruction. Four primary file
digests from that check:

```text
package.json  1a0885f01443fd7605550b68cdb2a8f21323b5847d5db1ec57ff4756944da77d
audit.mjs     fa64a16158f59f6e92d3d1baef9a08a6021ce4018ac7e0d3ab5ef4209532e2c0
spike.mjs     1b3070c3a5a79f990dee86f5fcf0764c2b8a0b36cb58e61b8fe98ec00098eb5a
bun.lock      5455acbd41b10a1661be644889fc6c00187304ed7d709a5de9565289b4420261
```

Rerun on 2026-10-13 after scrubbing local paths and making the evidence-document path a
required argument of `verify-evidence.mjs` (the only embedded source that changed): in
the sandbox, `bun install --frozen-lockfile` reported `Checked 21 installs across 22
packages (no changes)`, `bun run test` passed all 7 scenarios with output identical to
the block above, `bun run audit` passed, and `bun verify-evidence.mjs <repo>/docs/spikes/2026-10-13-collaboration-sync.md`
passed for all five files. The four digests above are unchanged; the new
`verify-evidence.mjs` digest is:

```text
verify-evidence.mjs  3f2fabe542340eb50fe255e384456508287ec8aa770e53f78fb7dac29dabf640
```

Running it without an argument exits 2 with a usage message.

Final worktree inventory showed only the untracked release backlog file
and `?? docs/spikes/` (this document). Tracked `git diff --name-only`
is empty. Listener inspection after completed tests shows no listener on 41424.

| Scenario | Result | Assertion/evidence |
| --- | --- | --- |
| Two editors, real binary both directions | PASS | Server Uint8Array boundary; client ArrayBuffer assertions on every frame; seed text and sorted decoded state vectors agree |
| Late join | PASS | Reader joins after seed edit, catches up via Step1/Step2; text/vector agree |
| Reader attempts Update and content-bearing Step2 | PASS | Two valid `FORBIDDEN` document payloads; each increments its rejection counter; encoded server update bytes remain identical after each; reader subsequently receives `-online` |
| Concurrent disconnected edits | PASS | Both editors offline; each inserts at the same shared position; server stays unchanged until reconnect; all three clients/server converge to `seed-online-A-B` with equal vectors |
| Disconnect/reconnect again | PASS | A misses B's `-later` edit, then catches up; text/vector converge |
| Awareness sanitization/removal | PASS | Client claims B's ID and admin fields; server rewrites ID to A's assigned 101 and name to Editor A, owns clock, drops extra fields; graceful socket close removes state and broadcasts null to reader |
| Bounded cap/malformed negatives | PASS | One 4097-byte frame against 4096 application cap; four tiny invalid protocol/update frames; one text frame; state unchanged; next valid editor change reaches reader |

Negatives are deliberately small; there is no malicious resource-exhaustion payload.
The Bun transport cap is 8192 bytes; the tested 4097-byte frame is rejected by the
application **before protocol parsing**. Transport-level over-cap closure was not
tested. Unknown/trailing frames and structural decode exceptions are rejected without
closing the test socket. This is not proof of exhaustive hostile-input resilience.

## Known unknowns and boundaries

- **Synthetic role gate only.** Public fixture paths `a`, `b`, `r` select hardcoded
  server-side test identities/roles, and duplicate active fixtures are rejected. This
  is expressly **not authentication**. Production needs session/cookie validation,
  registered-route authorization, canvas/workspace/document scope, guest-link and
  viewer/editor/manager/admin policy, trusted identity, Origin checks, rate limits,
  revocation/rechecks, and no client-selected privileges. None is proven here.
- **No persistence, crash recovery, DB integration, process restart, multi-instance
  routing, durable offline client storage, snapshots, compaction, retention/history,
  or migration.** Reconnect keeps the same in-memory client/server Y.Doc alive.
  Passing reconnect is not a crash/reload recovery claim.
- **Y.Text transport spike, not TipTap/ProseMirror XmlFragment integration.** No browser
  was exercised; clients are Bun's native WebSocket implementation. Editor schema,
  collaboration-aware undo, rich-text fidelity, Markdown migration/import/export,
  delete-heavy workloads, and actual web consumer contracts remain unproven.
- Single loopback room, two editors, one reader, deterministic insert-only test;
  no load/latency benchmark, TLS/proxy/deployment test, backpressure/drain test, fuzzing,
  document/struct budget enforcement, or denial-of-service claim. A frame byte limit
  and `Y.decodeUpdate` are not sufficient production limits on memory/CPU/semantic content.
  Structural decode is not a general atomic rollback guarantee for every malformed update.
- Reader rejection is silent in this fixture. There is no production error contract,
  acknowledgement/retry protocol, sync-complete event, or read-only UI enforcement.
  Real unauthorized local edits could leave a reader's own local doc divergent;
  this test deliberately sends a separate rogue doc, leaving its reader doc intact.
- Awareness is ephemeral and separate from content. It permits one entry/frame,
  server-assigned IDs/clocks and bounded cursor coordinates; no client HTML is retained.
  Graceful-close removal is proven, not timeout/abrupt network loss, heartbeat scaling,
  or revocation removal. It is a custom fixture policy, not a drop-in generic provider.
- MIT texts for the four direct packages were checked. Dependency vulnerabilities,
  all transitive licenses, and production license obligations require separate review.

## Complete rerunnable sandbox files

Copy each following fence **verbatim** into a new external sandbox under its heading.
These are complete files, not excerpts; no reliance on temporary source surviving
cleanup. Keep `bun.lock` as well as `package.json` to preserve peer/transitive resolutions.
Use Bun **1.3.14**, confirm port **41424** is free, and never reuse another server.
The main script starts and stops its own Elysia listener.

For example, after creating/checking the chosen external directory and copying files:

```sh
S="$SPIKE_DIR"   # external temporary directory containing the files below
bun --version
lsof -nP -iTCP:41424 -sTCP:LISTEN
bun install --cwd "$S" --frozen-lockfile
bun run --cwd "$S" audit
bun run --cwd "$S" test
bun run --cwd "$S" test
# Required: pass the saved evidence document as the only argument:
bun --cwd "$S" verify-evidence.mjs <repo>/docs/spikes/2026-10-13-collaboration-sync.md
lsof -nP -iTCP:41424 -sTCP:LISTEN
```

### `package.json`

```json
{
  "name": "wooble-collaboration-transport-spike",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.14",
  "scripts": { "audit": "bun audit.mjs", "test": "bun spike.mjs" },
  "dependencies": {
    "elysia": "1.4.30",
    "yjs": "13.6.33",
    "y-protocols": "1.0.7",
    "lib0": "0.2.119"
  }
}
```

### `verify-evidence.mjs`

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const path = Bun.argv[2];
if (!path) {
  console.error("usage: bun verify-evidence.mjs <path-to-evidence-doc>");
  process.exit(2);
}
const evidence = await Bun.file(path).text();
for (const file of ["package.json", "audit.mjs", "spike.mjs", "bun.lock", "verify-evidence.mjs"]) {
  const heading = `### \`${file}\``;
  const section = evidence.slice(evidence.indexOf(heading) + heading.length);
  const fenced = section.match(/```[^\n]*\n([\s\S]*?)\n```/);
  assert.ok(fenced, `complete fence for ${file}`);
  const embedded = `${fenced[1]}\n`;
  const original = await Bun.file(new URL(file, import.meta.url)).text();
  assert.equal(embedded, original, `embedded ${file} must equal executed sandbox source byte-for-byte`);
  console.log(`PASS embedded ${file} equals sandbox; sha256=${createHash("sha256").update(original).digest("hex")}`);
}
```

### `audit.mjs`

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

assert.equal(Bun.version, "1.3.14");
const manifest = await Bun.file(new URL("package.json", import.meta.url)).json();
console.log(`runtime bun ${Bun.version}; ${process.platform}/${process.arch}`);
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const url = `https://registry.npmjs.org/${name}/${version}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const registry = await response.json();
  const installed = await Bun.file(new URL(`node_modules/${name}/package.json`, import.meta.url)).json();
  const license = await Bun.file(new URL(`node_modules/${name}/LICENSE`, import.meta.url)).text();
  assert.equal(registry.version, version);
  assert.equal(installed.version, version);
  assert.equal(installed.license, "MIT");
  assert.equal(registry.license, installed.license);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const sha256 = createHash("sha256").update(license).digest("hex");
  console.log(JSON.stringify({ name, version, license: installed.license, source: url,
    repository: installed.repository, licenseFile: `node_modules/${name}/LICENSE`, sha256,
    tarballIntegrity: registry.dist.integrity, peerDependencies: installed.peerDependencies }));
}
console.log("PASS installed versions, registry metadata, and MIT license texts");
```

### `spike.mjs`

> Do not deploy: the client selects its role from the URL by design; synthetic roles only.

```js
import assert from "node:assert/strict";
import { Elysia, t } from "elysia";
import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as enc from "lib0/encoding";
import * as dec from "lib0/decoding";

assert.equal(Bun.version, "1.3.14");
const PORT = 41424;
const CAP = 4096;
const NETWORK = Symbol("network");
const fixtures = {
  a: { role: "editor", label: "Editor A", presenceID: 101 },
  b: { role: "editor", label: "Editor B", presenceID: 102 },
  r: { role: "reader", label: "Reader", presenceID: 103 },
}; // Public synthetic fixtures, NOT authentication or production authorization.
const doc = new Y.Doc();
const awareness = new awarenessProtocol.Awareness(doc);
awareness.setLocalState(null);
const peers = new Map();
const metrics = { binaryIn: 0, binaryOut: 0, rejectedUpdate: 0, rejectedStep2: 0,
  oversized: 0, malformed: 0, nonbinary: 0, awarenessSanitized: 0, awarenessRemoved: 0 };
const errors = [];

function frame(type, write) {
  const encoder = enc.createEncoder();
  enc.writeVarUint(encoder, type);
  write(encoder);
  return enc.toUint8Array(encoder);
}
const step1 = (document) => frame(0, (e) => sync.writeSyncStep1(e, document));
const updateFrame = (update) => frame(0, (e) => sync.writeUpdate(e, update));
const presenceFrame = (update) => frame(1, (e) => enc.writeVarUint8Array(e, update));
function send(peer, bytes) {
  if (peer.socket.readyState !== 1) return;
  const result = peer.socket.sendBinary(bytes); // Never ElysiaWS.send(Uint8Array).
  if (result === 0) errors.push("server binary send dropped");
  metrics.binaryOut++;
}
function broadcast(bytes) {
  for (const peer of peers.values()) send(peer, bytes);
}
doc.on("update", (update) => broadcast(updateFrame(update)));
awareness.on("update", ({ added, updated, removed }) => {
  const ids = [...added, ...updated, ...removed];
  broadcast(presenceFrame(awarenessProtocol.encodeAwarenessUpdate(awareness, ids)));
});

function end(decoder) {
  if (dec.hasContent(decoder)) throw new Error("trailing bytes");
}
function sanitizePresence(peer, bytes) {
  const decoder = dec.createDecoder(bytes);
  if (dec.readVarUint(decoder) !== 1) throw new Error("one awareness entry required");
  dec.readVarUint(decoder); // Discard client-supplied identity.
  dec.readVarUint(decoder); // Discard client-supplied clock.
  const state = JSON.parse(dec.readVarString(decoder));
  end(decoder);
  if (state !== null && (typeof state !== "object" || Array.isArray(state))) {
    throw new Error("invalid awareness state");
  }
  const c = state?.cursor;
  const cursor = c && Number.isFinite(c.x) && Number.isFinite(c.y) &&
    Math.abs(c.x) <= 1_000_000 && Math.abs(c.y) <= 1_000_000 ? { x: c.x, y: c.y } : null;
  const clean = state === null ? null : { user: { name: peer.label }, cursor };
  const e = enc.createEncoder();
  enc.writeVarUint(e, 1);
  enc.writeVarUint(e, peer.presenceID);
  const previous = awareness.meta.get(peer.presenceID)?.clock ?? 0;
  enc.writeVarUint(e, previous + 1);
  enc.writeVarString(e, JSON.stringify(clean));
  awarenessProtocol.applyAwarenessUpdate(awareness, enc.toUint8Array(e), NETWORK);
  metrics.awarenessSanitized++;
}

const app = new Elysia({
  serve: { reusePort: false },
  websocket: { maxPayloadLength: 8192, perMessageDeflate: false,
    backpressureLimit: 16384, closeOnBackpressureLimit: true },
}).ws("/sync/:peer", {
  params: t.Object({ peer: t.Union([t.Literal("a"), t.Literal("b"), t.Literal("r")]) }),
  open(socket) {
    const fixture = fixtures[socket.data.params.peer];
    if ([...peers.values()].some((p) => p.presenceID === fixture.presenceID)) {
      socket.close(1008, "fixture already connected");
      return;
    }
    const peer = { ...fixture, socket };
    peers.set(socket.raw, peer);
    if (peer.role === "editor") send(peer, step1(doc));
    const ids = [...awareness.getStates().keys()];
    if (ids.length) send(peer, presenceFrame(awarenessProtocol.encodeAwarenessUpdate(awareness, ids)));
  },
  message(socket, message) {
    const peer = peers.get(socket.raw);
    if (!peer) return;
    if (!(message instanceof Uint8Array)) { metrics.nonbinary++; return; }
    metrics.binaryIn++;
    if (message.byteLength > CAP) { metrics.oversized++; return; }
    try {
      const decoder = dec.createDecoder(message);
      const outer = dec.readVarUint(decoder);
      if (outer === 1) {
        const payload = dec.readVarUint8Array(decoder);
        end(decoder);
        sanitizePresence(peer, payload);
        return;
      }
      if (outer !== 0) throw new Error("unknown outer type");
      const inner = dec.readVarUint(decoder);
      // Gate BEFORE decoding/applying either mutating variant. Do not call
      // readSyncMessage first: that helper would already apply Step2/Update.
      if (peer.role !== "editor" && (inner === 1 || inner === 2)) {
        if (inner === 1) metrics.rejectedStep2++; else metrics.rejectedUpdate++;
        return;
      }
      if (inner !== 0 && inner !== 1 && inner !== 2) throw new Error("unknown sync type");
      const payload = dec.readVarUint8Array(decoder);
      end(decoder);
      if (inner === 0) send(peer, frame(0, (e) => sync.writeSyncStep2(e, doc, payload)));
      else {
        Y.decodeUpdate(payload); // Bounded structural validation before application.
        Y.applyUpdate(doc, payload, NETWORK);
      }
    } catch { metrics.malformed++; }
    // Return undefined; Elysia must not auto-serialize a returned Uint8Array.
  },
  close(socket) {
    const peer = peers.get(socket.raw);
    if (!peer) return;
    peers.delete(socket.raw);
    if (awareness.getStates().has(peer.presenceID)) {
      awarenessProtocol.removeAwarenessStates(awareness, [peer.presenceID], NETWORK);
      metrics.awarenessRemoved++;
    }
  },
});

async function until(label, predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (errors.length) throw new Error(errors.join("; "));
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await Bun.sleep(5);
  }
  assert.deepEqual(errors, []);
}
class Client {
  constructor(key, clientID) {
    this.key = key;
    this.doc = new Y.Doc();
    this.doc.clientID = clientID; // Deterministic fictional test clients.
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.binaryIn = 0;
    this.binaryOut = 0;
    this.step2In = 0;
    this.doc.on("update", (update, origin) => {
      if (origin !== NETWORK && fixtures[key].role === "editor") this.send(updateFrame(update));
    });
  }
  send(bytes) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      assert.ok(bytes instanceof Uint8Array);
      this.socket.send(bytes);
      this.binaryOut++;
    }
  }
  async connect() {
    const before = this.step2In;
    this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/sync/${this.key}`);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => {
      try {
        assert.ok(event.data instanceof ArrayBuffer, "server frame must be binary, not text/JSON");
        this.binaryIn++;
        const decoder = dec.createDecoder(new Uint8Array(event.data));
        const outer = dec.readVarUint(decoder);
        if (outer === 1) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, dec.readVarUint8Array(decoder), NETWORK);
          end(decoder);
          return;
        }
        assert.equal(outer, 0);
        const inner = dec.readVarUint(decoder);
        const payload = dec.readVarUint8Array(decoder);
        end(decoder);
        if (inner === 0) {
          if (fixtures[this.key].role === "editor") {
            this.send(frame(0, (e) => sync.writeSyncStep2(e, this.doc, payload)));
          }
        } else {
          assert.ok(inner === 1 || inner === 2);
          Y.applyUpdate(this.doc, payload, NETWORK);
          if (inner === 1) this.step2In++;
        }
      } catch (error) { errors.push(String(error)); }
    });
    this.socket.addEventListener("error", () => errors.push(`socket error: ${this.key}`));
    await until(`${this.key} open`, () => this.socket.readyState === WebSocket.OPEN);
    this.send(step1(this.doc));
    await until(`${this.key} handshake`, () => this.step2In > before);
  }
  async disconnect() {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    socket.close(1000, "test disconnect");
    await until(`${this.key} closed`, () => socket.readyState === WebSocket.CLOSED &&
      ![...peers.values()].some((p) => p.presenceID === fixtures[this.key].presenceID));
  }
  text() { return this.doc.getText("body").toString(); }
  async destroy() {
    await this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
function vector(document) {
  return JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(document))].sort((a, b) => a[0] - b[0]));
}
async function converged(clients) {
  await until("text and state-vector convergence", () => clients.every((c) =>
    c.text() === doc.getText("body").toString() && vector(c.doc) === vector(doc)));
}
const a = new Client("a", 11);
const b = new Client("b", 22);
const r = new Client("r", 33);
const rogue = new Y.Doc();
rogue.clientID = 44;
try {
  app.listen({ hostname: "127.0.0.1", port: PORT, reusePort: false });
  console.log(`runtime bun ${Bun.version}; Elysia localhost:${PORT}; cap=${CAP}`);
  await a.connect();
  await b.connect();
  a.doc.getText("body").insert(0, "seed");
  await converged([a, b]);
  assert.ok(metrics.binaryIn > 0 && metrics.binaryOut > 0 && a.binaryIn > 0 && b.binaryIn > 0);
  console.log("PASS two editors: native binary send/receive; text=seed");

  await r.connect();
  await converged([a, b, r]);
  assert.equal(r.text(), "seed");
  console.log("PASS late-joining reader: SyncStep1/SyncStep2 catches up");

  rogue.getText("body").insert(0, "FORBIDDEN");
  const before = Buffer.from(Y.encodeStateAsUpdate(doc));
  r.send(updateFrame(Y.encodeStateAsUpdate(rogue)));
  await until("reader Update rejected", () => metrics.rejectedUpdate === 1);
  assert.deepEqual(Buffer.from(Y.encodeStateAsUpdate(doc)), before);
  r.send(frame(0, (e) => sync.writeSyncStep2(e, rogue)));
  await until("reader Step2 rejected", () => metrics.rejectedStep2 === 1);
  assert.deepEqual(Buffer.from(Y.encodeStateAsUpdate(doc)), before);
  b.doc.getText("body").insert(b.text().length, "-online");
  await converged([a, b, r]);
  assert.equal(r.text(), "seed-online");
  console.log("PASS reader Update + content-bearing SyncStep2 blocked; byte-identical server state after EACH; receives editor updates");

  await a.disconnect();
  await b.disconnect();
  const offlineBaseline = doc.getText("body").toString();
  a.doc.getText("body").insert(a.text().length, "-A");
  b.doc.getText("body").insert(b.text().length, "-B");
  assert.equal(doc.getText("body").toString(), offlineBaseline);
  assert.notEqual(a.text(), b.text());
  await a.connect();
  await b.connect();
  await converged([a, b, r]);
  assert.equal(a.text(), "seed-online-A-B");
  console.log(`PASS concurrent disconnected edits + reconnect: all text/state vectors converge; text=${a.text()}`);
  await a.disconnect();
  b.doc.getText("body").insert(b.text().length, "-later");
  await converged([b, r]);
  assert.notEqual(a.text(), b.text());
  await a.connect();
  await converged([a, b, r]);
  assert.equal(a.text(), "seed-online-A-B-later");
  console.log("PASS second disconnect/reconnect recovers missed editor update");

  const presence = enc.createEncoder();
  enc.writeVarUint(presence, 1);
  enc.writeVarUint(presence, 102); // Deliberately tries to impersonate B.
  enc.writeVarUint(presence, 999);
  enc.writeVarString(presence, JSON.stringify({ user: { name: "Pretend Admin", role: "admin" },
    cursor: { x: 1, y: 2, secret: "discard" }, html: "discard", token: "fictional" }));
  a.send(presenceFrame(enc.toUint8Array(presence)));
  await until("sanitized presence delivered", () => r.awareness.getStates().has(101));
  assert.deepEqual(r.awareness.getStates().get(101), { user: { name: "Editor A" }, cursor: { x: 1, y: 2 } });
  assert.equal(awareness.getStates().has(102), false);
  await a.disconnect();
  await until("presence removal delivered", () => !r.awareness.getStates().has(101));
  assert.equal(awareness.getStates().has(101), false);
  console.log("PASS awareness: server identity/clock, whitelisted fields, spoofed ID ignored; close removes/broadcasts presence");

  const healthy = Buffer.from(Y.encodeStateAsUpdate(doc));
  b.send(new Uint8Array(CAP + 1)); // 4097 bytes only, below transport cap; not a DoS probe.
  b.send(new Uint8Array([0, 2, 5, 1])); // Truncated declared update length.
  b.send(new Uint8Array([9])); // Unknown outer type.
  b.send(new Uint8Array([0, 9])); // Unknown inner type.
  b.send(new Uint8Array([0, 2, 1, 255])); // Small malformed Yjs update.
  b.socket.send("not-binary");
  await until("bounded negatives rejected", () => metrics.oversized === 1 && metrics.malformed === 4 && metrics.nonbinary === 1);
  assert.deepEqual(Buffer.from(Y.encodeStateAsUpdate(doc)), healthy);
  b.doc.getText("body").insert(b.text().length, "-healthy");
  await converged([b, r]);
  console.log("PASS negatives: 4097-byte frame, truncated/unknown/malformed messages and text rejected; unchanged state, next valid update works");
  assert.deepEqual(errors, []);
  console.log(`METRICS ${JSON.stringify(metrics)}`);
  console.log(`CLIENT_BINARY ${JSON.stringify([a, b, r].map((c) => ({ client: c.key, in: c.binaryIn, out: c.binaryOut })))}`);
  console.log("PASS all 7 scenarios");
} finally {
  try {
    for (const client of [a, b, r]) await client.destroy();
  } finally {
    await app.stop(true);
    awareness.destroy();
    doc.destroy();
    rogue.destroy();
    console.log("STOP own listener 41424; documents/awareness destroyed");
  }
}
```

### `bun.lock`

```jsonc
{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "wooble-collaboration-transport-spike",
      "dependencies": {
        "elysia": "1.4.30",
        "lib0": "0.2.119",
        "y-protocols": "1.0.7",
        "yjs": "13.6.33",
      },
    },
  },
  "packages": {
    "@borewit/text-codec": ["@borewit/text-codec@0.2.2", "", {}, "sha512-DDaRehssg1aNrH4+2hnj1B7vnUGEjU6OIlyRdkMd0aUdIUvKXrJfXsy8LVtXAy7DRvYVluWbMspsRhz2lcW0mQ=="],

    "@sinclair/typebox": ["@sinclair/typebox@0.34.52", "", {}, "sha512-XiMQh7qqVlxZzcVD+kkGMNGMzcTrDMLWI7S4x7z1MkCkbDPrekpZXEUK0eZqZFMuHQg2a2DZOcDIh9o5v3Gonw=="],

    "@tokenizer/inflate": ["@tokenizer/inflate@0.4.1", "", { "dependencies": { "debug": "^4.4.3", "token-types": "^6.1.1" } }, "sha512-2mAv+8pkG6GIZiF1kNg1jAjh27IDxEPKwdGul3snfztFerfPGI1LjDezZp3i7BElXompqEtPmoPx6c2wgtWsOA=="],

    "@tokenizer/token": ["@tokenizer/token@0.3.0", "", {}, "sha512-OvjF+z51L3ov0OyAU0duzsYuvO01PH7x4t6DJx+guahgTnBHkhJdG7soQeTSFLWN3efnHyibZ4Z8l2EuWwJN3A=="],

    "cookie": ["cookie@1.1.1", "", {}, "sha512-ei8Aos7ja0weRpFzJnEA9UHJ/7XQmqglbRwnf2ATjcB9Wq874VKH9kfjjirM6UhU2/E5fFYadylyhFldcqSidQ=="],

    "debug": ["debug@4.4.3", "", { "dependencies": { "ms": "^2.1.3" }, "peerDependencies": { "supports-color": "*" }, "optionalPeers": ["supports-color"] }, "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA=="],

    "elysia": ["elysia@1.4.30", "", { "dependencies": { "cookie": "^1.1.1", "exact-mirror": "^0.2.7", "fast-decode-uri-component": "^1.0.1", "memoirist": "^0.4.0" }, "peerDependencies": { "@sinclair/typebox": ">= 0.34.0 < 1", "@types/bun": ">= 1.2.0", "file-type": ">= 20.0.0", "openapi-types": ">= 12.0.0", "typescript": ">= 5.0.0" }, "optionalPeers": ["@types/bun", "typescript"] }, "sha512-S2qqV0CbM4faB1hQQ5IYoeYnAUinjHlzRduxaBc4OoNqh0GjOc8k6tt3hv5ozWcG6Svr6hugw6JL4zNke4jwfA=="],

    "exact-mirror": ["exact-mirror@0.2.7", "", { "peerDependencies": { "@sinclair/typebox": "^0.34.15" }, "optionalPeers": ["@sinclair/typebox"] }, "sha512-+MeEmDcLA4o/vjK2zujgk+1VTxPR4hdp23qLqkWfStbECtAq9gmsvQa3LW6z/0GXZyHJobrCnmy1cdeE7BjsYg=="],

    "fast-decode-uri-component": ["fast-decode-uri-component@1.0.1", "", {}, "sha512-WKgKWg5eUxvRZGwW8FvfbaH7AXSh2cL+3j5fMGzUMCxWBJ3dV3a7Wz8y2f/uQ0e3B6WmodD3oS54jTQ9HVTIIg=="],

    "file-type": ["file-type@22.1.1", "", { "dependencies": { "@tokenizer/inflate": "^0.4.1", "strtok3": "^10.3.5", "token-types": "^6.1.2", "uint8array-extras": "^1.5.0" } }, "sha512-sEB0oStmeLGtpmSAD88RDNuLsvhv4iC3u0lE25CUvfCULvj49xoQ3l3K525Vn+ZzsZ6DOLajQCV6RmhwwhqiJg=="],

    "ieee754": ["ieee754@1.2.1", "", {}, "sha512-dcyqhDvX1C46lXZcVqCpK+FtMRQVdIMN6/Df5js2zouUsqG7I6sFxitIC+7KYK29KdXOLHdu9zL4sFnoVQnqaA=="],

    "isomorphic.js": ["isomorphic.js@0.2.5", "", {}, "sha512-PIeMbHqMt4DnUP3MA/Flc0HElYjMXArsw1qwJZcm9sqR8mq3l8NYizFMty0pWwE/tzIGH3EKK5+jes5mAr85yw=="],

    "lib0": ["lib0@0.2.119", "", { "dependencies": { "isomorphic.js": "^0.2.4" }, "bin": { "0serve": "bin/0serve.js", "0gentesthtml": "bin/gentesthtml.js", "0ecdsa-generate-keypair": "bin/0ecdsa-generate-keypair.js" } }, "sha512-vh+TiejVy8Xm+hCdnRfn9BthGNvNUZdEXltNjVZL3TzRIKP3s1lnQh8pWd/Q0wCgY0FPAGVVjFF4ZiHUV3LFgA=="],

    "memoirist": ["memoirist@0.4.0", "", {}, "sha512-zxTgA0mSYELa66DimuNQDvyLq36AwDlTuVRbnQtB+VuTcKWm5Qc4z3WkSpgsFWHNhexqkIooqpv4hdcqrX5Nmg=="],

    "ms": ["ms@2.1.3", "", {}, "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=="],

    "openapi-types": ["openapi-types@12.1.3", "", {}, "sha512-N4YtSYJqghVu4iek2ZUvcN/0aqH1kRDuNqzcycDxhOUpg7GdvLa2F3DgS6yBNhInhv2r/6I0Flkn7CqL8+nIcw=="],

    "strtok3": ["strtok3@10.4.1", "", { "dependencies": { "@tokenizer/token": "^0.3.0" } }, "sha512-MeSp4vHXiZRXM9K0rSWqTvXMU+YzmGICc5+briMVK+RY8qQ1GRTffFYVpK6cSgV/ueImFIEh3uCJJD3xBh1TaQ=="],

    "token-types": ["token-types@6.1.2", "", { "dependencies": { "@borewit/text-codec": "^0.2.1", "@tokenizer/token": "^0.3.0", "ieee754": "^1.2.1" } }, "sha512-dRXchy+C0IgK8WPC6xvCHFRIWYUbqqdEIKPaKo/AcTUNzwLTK6AH7RjdLWsEZcAN/TBdtfUw3PYEgPr5VPr6ww=="],

    "uint8array-extras": ["uint8array-extras@1.6.0", "", {}, "sha512-8iAasVS4wUx0gPLjH8Xtz2PeDzTSiy8QiLGu2DT3X5GU+egFEQhpnbtkehbAwjvDcxIERmCYcysiODFmE3Ud0Q=="],

    "y-protocols": ["y-protocols@1.0.7", "", { "dependencies": { "lib0": "^0.2.85" }, "peerDependencies": { "yjs": "^13.0.0" } }, "sha512-YSVsLoXxO67J6eE/nV4AtFtT3QEotZf5sK5BHxFBXso7VDUT3Tx07IfA6hsu5Q5OmBdMkQVmFZ9QOA7fikWvnw=="],

    "yjs": ["yjs@13.6.33", "", { "dependencies": { "lib0": "^0.2.99" } }, "sha512-q/UYvr1gOk4XII+Cu1CW2dINjYqJJFifTzogEaIARznrvX7uOlHsdTEXcnOBMuIsrCGEEKdNxi74kyMLZlKVfw=="],
  }
}
```
