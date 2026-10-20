# Headless parser spike: the documentation editor on a Yjs XmlFragment under Bun

Date: 2026-10-20. **Result: works with caveats.** The app's own editor schema, Markdown parser and serializer run under Bun with no browser, on top of a Yjs `XmlFragment`. This is evidence for [the collaboration ADR](../decisions/collaboration-sync.md) (#16), not a production implementation.

## Question

The ADR makes the server the only party that turns stored Markdown into a collaborative document (bootstrap), and it projects every commit back to Markdown (the mirror). Both need the web editor's schema and Markdown conversion to run headless under Bun. The [transport spike](2026-10-13-collaboration-sync.md) used `Y.Text`, not a TipTap/ProseMirror `XmlFragment`, so this was unproven (ADR, "What the spike did not prove").

## Method

- Throwaway git worktree from `main` at `aabe25b`. Its scripts and the extra packages are not committed. Only this report is.
- Versions:
  - Bun 1.3.14
  - TipTap 3.31.4, including `@tiptap/markdown`
  - `@tiptap/y-tiptap` 3.0.10 (the binding the ADR names, not `y-prosemirror`)
  - yjs 13.6.33
  - y-protocols 1.0.7 (installed, not exercised)
  - happy-dom 20.14.5, used only for the shim described below
- Server pipeline:
  1. `new Editor({ element: null, extensions: documentationExtensions() })` with the app's real extension list (`apps/web/src/features/inspector/documentation/extensions.ts`) and Markdown content.
  2. `prosemirrorToYXmlFragment` into `getXmlFragment("default")`.
  3. Encode the state, apply it to a fresh `Y.Doc`, then `yXmlFragmentToProseMirrorRootNode`.
  4. Serialize with the app's serializer. The script asserts that `document` and `window` are undefined.
- Corpus: the 36 round-trip fixtures in `apps/web/tests/documentation-markdown.test.ts`.
- Client comparison: a mounted editor with the Collaboration extension under happy-dom, in-memory update exchange (no transport).
- The server scripts were run a second time, and the reported outcomes were checked in their logs, before this report was written.

## Results

| Fixtures | Markdown → Y.Doc → Markdown stable | Matches the client's own round trip |
| --- | --- | --- |
| 21 (headings, marks, lists, task lists, quote, code, divider, URLs, links, architecture document, lookalikes, fence in code, empty item, saved named references, `javascript:` link) | yes, byte-equal to the input | yes |
| 11 (table, long table cell, 8 canonical-syntax cases, named references) | yes, equal to the test's expected canonical output | yes |
| Empty document | no DOM: throws "there is no window object available" | only with the shim |
| `<br>` in a table cell (supported) | no DOM: written as `&lt;br&gt;`, losing the line break | only with the shim |
| Raw HTML, `<u>` (unsupported, already flagged) | stable, but escaped without a DOM | only with the shim |

- **Shim.** Setting `globalThis.window = { DOMParser }` from happy-dom, and nothing else, makes all 36 fixtures match. It changes a process-wide global. A cleaner fix is an app-side `<br>` → hard-break rule plus an explicit empty document.
- **The Yjs trip never changed a document.** The document read back equalled the parsed one in every case.
- **Concurrent edits.** Two Y.Docs inserting into a bootstrapped fragment converged without duplication or loss, both headless and with two mounted editors.
- **Updates on open.** A view-less load emits 0 Yjs updates. A mounted collaborative editor also emits 0 on open, but its view differs from the Y.Doc in 18 of 36 fixtures:
  - In 17, the editor adds a trailing paragraph after a document that ends in a non-paragraph block.
  - The link-safety rule strips a `javascript:` link in the view but not in the Y.Doc. The server keeps it too, because that rule is a view plugin.
- **The view-only changes reach Yjs on the first edit.** With two clients each making a first edit, the fragment ended as `bulletList, paragraph, paragraph`, and the mirror ended in `\n\n\n\n&nbsp;`.
- **Timing (median of 30).** A 696-character document parses in 0.9 ms. A 19,616-character document parses in 35 ms, converts in 1.6 ms, decodes in 3.5 ms and serializes in 2.4 ms. Its state is 82 KB.

## Meaning for the ADR

- **Proven:**
  - The headless schema and serializer run under Bun.
  - `@tiptap/y-tiptap` conversion works.
  - The round trip holds on the existing corpus, given the DOM caveat.
- **Needs amending, recorded in the ADR's 2026-10-20 amendments:**
  1. The single server parser must not depend on a DOM. Handle `<br>` and the empty document explicitly, or state the shim.
  2. The server must apply link safety itself, before bootstrap and on every commit.
  3. The trailing-paragraph rule must not diverge from the stored document. Either turn it off in collaborative mode, or have the server canonicalize the trailing paragraph at bootstrap.

## Not proven

- React `useEditor` in a real browser.
- A real transport or y-protocols framing.
- Fuzzing beyond the 36 fixtures.
- Persistence and authorization. Those remain with #33 and #34.
