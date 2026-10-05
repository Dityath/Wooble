import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { CanvasActivityLog } from "../src/features/canvas/canvas-activity-log";
import { canvasShortcutLabel, isApplePlatform } from "../src/features/canvas/canvas-shortcuts";
import { DatabaseSchema } from "../src/features/inspector/database-schema";
import { RichDocumentation } from "../src/features/inspector/rich-documentation";
import { CanvasShareDialog } from "../src/features/workspace/canvas-share-dialog";
import { editorFromElement, typeInEditor } from "./support/editor";
import { FakeApi, failWith } from "./support/fake-api";
import { canvasEvent, entity, graph, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery } from "./support/render";

let server: FakeApi;
beforeEach(() => {
  server = new FakeApi().install();
});
afterEach(() => server.restore());

const ordersSql = `CREATE TABLE customers (
  id UUID PRIMARY KEY,
  name TEXT
);
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id)
);`;

describe("entity detail page", () => {
  beforeEach(() => {
    server
      .on("GET /api/auth/me", user())
      .on("GET /api/workspaces", [workspace()])
      .on("GET /api/canvases", [])
      .on("GET /api/canvases/:id/access", { role: "viewer" });
  });

  it("shows configured details, documentation, and the link back to the canvas", async () => {
    server.on(
      "GET /api/entities/:id",
      entity(
        ids.service,
        "service",
        "Orders API",
        {
          language: "TypeScript",
          framework: "Elysia",
          interfaces: ["REST", "gRPC"],
          repositoryUrl: "https://git.example.test/orders",
          artifactUrl: "registry.example.test/orders:1.4",
          documentation: "## Ownership\n\nTeam **Checkout**",
        },
        "Accepts and tracks orders",
      ),
    );
    await renderRoute(`/entities/${ids.service}?canvasId=${ids.canvas}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Orders API" })).toBeTruthy();
    expect(server.requests("GET", `/api/entities/${ids.service}`)[0].query.get("canvasId")).toBe(ids.canvas);
    expect(screen.getByText("Accepts and tracks orders")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to canvas/ }).getAttribute("href")).toBe(`/canvases/${ids.canvas}`);
    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText("gRPC")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open repository/ }).getAttribute("href")).toBe(
      "https://git.example.test/orders",
    );
    expect(screen.getByText("registry.example.test/orders:1.4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ownership" })).toBeTruthy();
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
  });

  it("shows a database's read-only schema and falls back for unknown types", async () => {
    server.on("GET /api/entities/:id", entity(ids.database, "database", "Orders DB", { schemaSql: ordersSql }));
    await renderRoute(`/entities/${ids.database}`);
    expect(await screen.findByRole("heading", { name: "Database schema" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>("SQL schema").readOnly).toBe(true);
    expect(screen.getByText("2 tables · 1 relationships")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to library/ }).getAttribute("href")).toBe("/canvases");
    expect(screen.getByText("No documentation yet.")).toBeTruthy();
  });

  it("labels unfamiliar entity types and reports load errors", async () => {
    server.on("GET /api/entities/:id", { ...entity(ids.gateway, "external", "Card network"), type: "mainframe" });
    await renderRoute(`/entities/${ids.gateway}`);
    expect(await screen.findByText("Entity")).toBeTruthy();
    expect(screen.getByText("mainframe")).toBeTruthy();
  });

  it("reports an entity that cannot be loaded", async () => {
    server.on("GET /api/entities/:id", failWith(404, "Entity not found"));
    await renderRoute(`/entities/${ids.gateway}`);
    expect(await screen.findByRole("heading", { name: "Entity unavailable" })).toBeTruthy();
    expect(screen.getByText("Entity not found")).toBeTruthy();
  });
});

describe("canvas share dialog", () => {
  function ShareHarness() {
    const [open, setOpen] = useState(true);
    return <CanvasShareDialog canvasId={ids.canvas} open={open} onOpenChange={setOpen} />;
  }

  it("turns on link sharing and copies the link", async () => {
    let canvas = graph().canvas;
    server
      .on("GET /api/canvases/:id", () => canvas)
      .on("PATCH /api/canvases/:id", ({ body }) => {
        canvas = { ...canvas, ...(body as object) };
        return canvas;
      });
    const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      const { user: actor } = renderWithQuery(<ShareHarness />);
      const save = await screen.findByRole<HTMLButtonElement>("button", { name: "Save access" });
      expect(screen.getByRole<HTMLInputElement>("radio", { name: /Restricted/ }).checked).toBe(true);
      expect(save.disabled).toBe(true);

      await actor.click(screen.getByRole("radio", { name: /Anyone with link/ }));
      expect(screen.getByText("Save access to enable the link.")).toBeTruthy();
      await actor.click(save);

      const link = await screen.findByLabelText<HTMLInputElement>("Canvas share link");
      expect(link.value).toBe(`http://localhost:5173/canvases/${ids.canvas}`);
      expect(server.requests("PATCH", `/api/canvases/${ids.canvas}`)[0].body).toEqual({ shareMode: "link" });
      await actor.click(screen.getByRole("button", { name: "Copy link" }));
      expect(copy).toHaveBeenCalledWith(link.value);
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

      // The first "Close" is the footer action; the second is the dialog's corner button.
      await actor.click(screen.getAllByRole("button", { name: "Close" })[0]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      copy.mockRestore();
    }
  });

  it("reports load and save errors", async () => {
    server
      .on("GET /api/canvases/:id", { ...graph().canvas, shareMode: "link" })
      .on("PATCH /api/canvases/:id", failWith(403, "Only managers can share"));
    const { user: actor } = renderWithQuery(<ShareHarness />);
    await actor.click(await screen.findByRole("radio", { name: /Restricted/ }));
    await actor.click(screen.getByRole("button", { name: "Save access" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Only managers can share");
  });

  it("shows why sharing settings are unavailable", async () => {
    server.on("GET /api/canvases/:id", failWith(404, "Canvas not found"));
    renderWithQuery(<ShareHarness />);
    expect((await screen.findByRole("alert")).textContent).toBe("Canvas not found");
  });
});

describe("canvas activity log", () => {
  function ActivityHarness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
      <>
        <input aria-label="Scratch field" />
        <CanvasActivityLog canvasId={ids.canvas} open={open} onOpenChange={setOpen} />
      </>
    );
  }

  it("lists recent changes with relative times and undone markers", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    server.on("GET /api/canvases/:id/activity", {
      events: [
        canvasEvent({ id: "50000000-0000-4000-8000-000000000001", createdAt: ago(10) }),
        canvasEvent({
          id: "50000000-0000-4000-8000-000000000002",
          action: "canvas.auto_neat",
          targetName: null,
          createdAt: ago(5 * 60),
        }),
        canvasEvent({
          id: "50000000-0000-4000-8000-000000000003",
          action: "connection.deleted",
          actorUserId: null,
          actorName: "grace",
          undoneAt: ago(60),
          createdAt: ago(3 * 3600),
        }),
        canvasEvent({ id: "50000000-0000-4000-8000-000000000004", action: "something.new", createdAt: ago(2 * 86400) }),
      ],
    });
    try {
      renderWithQuery(<ActivityHarness />);
      const log = screen.getByRole("region", { name: "Canvas activity" });
      await within(log).findByText("updated");
      expect(within(log).getByText("just now")).toBeTruthy();
      expect(within(log).getByText("tidied the layout of")).toBeTruthy();
      expect(within(log).getByText("5m ago")).toBeTruthy();
      expect(within(log).getByText("undone · 3h ago")).toBeTruthy();
      expect(within(log).getByText("G")).toBeTruthy();
      expect(within(log).getByText("changed")).toBeTruthy();
      expect(within(log).getByText("2d ago")).toBeTruthy();
      expect(server.requests("GET", `/api/canvases/${ids.canvas}/activity`)[0].query.get("limit")).toBe("50");
    } finally {
      clock.mockRestore();
    }
  });

  it("shows empty and error states", async () => {
    server.on("GET /api/canvases/:id/activity", { events: [] });
    renderWithQuery(<ActivityHarness />);
    expect(await screen.findByText("No activity yet")).toBeTruthy();
  });

  it("reports activity that cannot load", async () => {
    server.on("GET /api/canvases/:id/activity", failWith(500, "boom"));
    renderWithQuery(<ActivityHarness />);
    expect(await screen.findByText("Could not load activity")).toBeTruthy();
  });

  it("opens from the toggle and closes with Escape unless typing in a field", async () => {
    server.on("GET /api/canvases/:id/activity", { events: [] });
    const { user: actor } = renderWithQuery(<ActivityHarness initiallyOpen={false} />);
    const toggle = screen.getByRole("button", { name: "Toggle activity log" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(server.calls).toEqual([]);

    await actor.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await actor.click(screen.getByLabelText("Scratch field"));
    await actor.keyboard("{Escape}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await actor.click(toggle);
    await actor.click(screen.getByRole("button", { name: "Close activity log", hidden: true }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("refreshes relative times every 30 seconds", () => {
    const intervals = spyOn(globalThis, "setInterval");
    server.on("GET /api/canvases/:id/activity", { events: [] });
    renderWithQuery(<ActivityHarness />);
    const tick = intervals.mock.calls.find(([, delay]) => delay === 30_000)?.[0] as () => void;
    intervals.mockRestore();
    expect(tick).toBeTruthy();
    act(() => tick());
  });
});

describe("rich documentation", () => {
  const documentation = () => screen.getByRole("textbox", { name: "Documentation" });
  const saveState = () => screen.getByRole("status").textContent;
  const focusDocumentation = () => act(async () => editorFromElement(documentation()).view.focus());
  const blurDocumentation = () => act(async () => documentation().blur());
  /** Places the caret at the end of the last block, as clicking after the text does. */
  const caretToEnd = () =>
    act(() => {
      const editor = editorFromElement(documentation());
      editor.commands.setTextSelection(editor.state.doc.content.size);
    });
  /** Saves that stay in flight until the test finishes them, in order. */
  function pendingSaves() {
    const finish: Array<() => void> = [];
    const onSave = mock((_value: string) => new Promise<void>((resolve) => finish.push(resolve)));
    return { onSave, finish };
  }
  /**
   * Runs `edit` and returns the autosave it schedules, so a test can run the autosave without waiting out the pause.
   * Each edit replaces the previous timer, so the last one counts. Timers are recorded with a plain wrapper: with a mock
   * `setTimeout`, Testing Library would expect Jest fake timers.
   */
  async function autosaveAfter(edit: () => Promise<void>) {
    const realSetTimeout = globalThis.setTimeout;
    let autosave: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 900 && typeof handler === "function") autosave = handler as () => void;
      return realSetTimeout(handler, delay, ...args);
    }) as unknown as typeof setTimeout;
    try {
      await edit();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    if (!autosave) throw new Error("No autosave was scheduled 900 ms after the edit.");
    const run = autosave;
    return () => act(async () => run());
  }

  it("opens existing Markdown as editable blocks", () => {
    const value = [
      "# Runbook",
      "Restart the **worker** after a deploy.",
      "- [x] Drain the queue\n- [ ] Deploy the release",
      "| Step | Owner |\n| --- | --- |\n| Drain | Platform |",
    ].join("\n\n");
    renderWithQuery(<RichDocumentation value={value} onSave={mock(async () => {})} />);
    const editor = documentation();
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(within(editor).getByRole("heading", { level: 1, name: "Runbook" })).toBeTruthy();
    expect(within(editor).getByText("worker").tagName).toBe("STRONG");
    expect(
      within(editor)
        .getAllByRole<HTMLInputElement>("checkbox")
        .map((box) => box.checked),
    ).toEqual([true, false]);
    expect(within(within(editor).getByRole("table")).getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Type / to insert blocks. Paste Markdown to convert it.")).toBeTruthy();
    expect(saveState()).toBe("");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("invites writing in an empty document", () => {
    renderWithQuery(<RichDocumentation value="" onSave={mock(async () => {})} />);
    const paragraph = documentation().querySelector("p.is-editor-empty");
    expect(paragraph?.getAttribute("data-placeholder")).toBe('Type "/" for blocks, or paste Markdown');
  });

  it("never saves documentation that is opened, focused, or left without an edit", async () => {
    const documents = [
      // The editor adds an empty paragraph after a final code block or table on the first transaction, such as a focus.
      { value: "```ts\nexport const retries = 3;\n```", afterFocus: "```ts\nexport const retries = 3;\n```\n\n" },
      {
        value: "| Service | Owner |\n| --- | --- |\n| Ledger | Payments |",
        afterFocus: "\n| Service | Owner    |\n| ------- | -------- |\n| Ledger  | Payments |\n\n\n",
      },
      // Equivalent syntax is written in one canonical form.
      {
        value: "* Gateway\n* Ledger\n\n__Owned__ by _Platform_",
        afterFocus: "- Gateway\n- Ledger\n\n**Owned** by *Platform*",
      },
    ];
    for (const { value, afterFocus } of documents) {
      const onSave = mock(async (_value: string) => {});
      const { unmount, user: actor } = renderWithQuery(
        <StrictMode>
          <RichDocumentation value={value} onSave={onSave} />
        </StrictMode>,
      );
      await focusDocumentation();
      expect(editorFromElement(documentation()).getMarkdown()).toBe(afterFocus);
      await actor.click(documentation());
      await blurDocumentation();
      expect(saveState()).toBe("");
      unmount();
      expect(onSave).not.toHaveBeenCalled();
    }
  });

  it("autosaves trimmed Markdown 900 ms after the last edit", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value="Gateway" onSave={onSave} />);
    const autosave = await autosaveAfter(async () => {
      await caretToEnd();
      await typeInEditor(documentation(), " API");
      // A new empty paragraph writes trailing blank lines, which the API would trim.
      await actor.keyboard("{Enter}");
    });
    expect(editorFromElement(documentation()).getMarkdown()).toBe("Gateway API\n\n");
    expect(saveState()).toBe("Unsaved changes");
    expect(onSave).not.toHaveBeenCalled();

    await autosave();
    expect(onSave.mock.calls).toEqual([["Gateway API"]]);
    await waitFor(() => expect(saveState()).toBe("Saved"));
  });

  it("saves as soon as the editor loses focus", async () => {
    const { onSave, finish } = pendingSaves();
    renderWithQuery(<RichDocumentation value="# Runbook" onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), " v2");
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([["# Runbook v2"]]);
    expect(saveState()).toBe("Saving…");

    await act(async () => finish[0]());
    expect(saveState()).toBe("Saved");
  });

  it("keeps the content of a failed save and retries it", async () => {
    let fail = true;
    const onSave = mock(async (_value: string) => {
      if (fail) throw new Error("Documentation could not be saved");
    });
    const { user: actor } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    await typeInEditor(documentation(), "Rotate the keys");
    await blurDocumentation();
    expect((await screen.findByRole("alert")).textContent).toContain("Documentation could not be saved");
    expect(documentation().textContent).toBe("Rotate the keys");
    expect(saveState()).toBe("Unsaved changes");

    fail = false;
    await actor.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onSave.mock.calls).toEqual([["Rotate the keys"], ["Rotate the keys"]]);
    expect(saveState()).toBe("Saved");
  });

  it("sends one save at a time and saves edits made during a save after it", async () => {
    const { onSave, finish } = pendingSaves();
    renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    await typeInEditor(documentation(), "First");
    await blurDocumentation();
    await caretToEnd();
    await typeInEditor(documentation(), " draft");
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([["First"]]);

    await act(async () => finish[0]());
    expect(onSave.mock.calls).toEqual([["First"], ["First draft"]]);
    expect(saveState()).toBe("Saving…");
    await act(async () => finish[1]());
    expect(saveState()).toBe("Saved");
  });

  it("shows documentation updated elsewhere while the editor is idle", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    rerender(<RichDocumentation value={"* Updated notes"} onSave={onSave} />);
    expect(within(documentation()).getByRole("listitem").textContent).toBe("Updated notes");

    // The update becomes the saved document, so leaving the editor does not save its canonical form.
    await focusDocumentation();
    await blurDocumentation();
    expect(onSave).not.toHaveBeenCalled();
    // The editor keeps an empty paragraph after the list to type in.
    await caretToEnd();
    await typeInEditor(documentation(), "Reviewed");
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([["- Updated notes\n\nReviewed"]]);
  });

  it("keeps the editor's content when documentation is updated elsewhere while it has focus", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    await focusDocumentation();
    rerender(<RichDocumentation value="Remote notes" onSave={onSave} />);
    expect(documentation().textContent).toBe("Old notes");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows documentation updated elsewhere once the editor is left without an edit", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    await focusDocumentation();
    rerender(<RichDocumentation value="Remote notes" onSave={onSave} />);
    expect(documentation().textContent).toBe("Old notes");

    await blurDocumentation();
    expect(documentation().textContent).toBe("Remote notes");
    expect(saveState()).toBe("");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not show an update that was undone elsewhere before the editor was left", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    await focusDocumentation();
    rerender(<RichDocumentation value="Remote notes" onSave={onSave} />);
    rerender(<RichDocumentation value="Old notes" onSave={onSave} />);
    await blurDocumentation();
    expect(documentation().textContent).toBe("Old notes");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves an edit over documentation updated elsewhere while the editor had focus", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    await focusDocumentation();
    rerender(<RichDocumentation value="Remote notes" onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), " and local edits");
    await blurDocumentation();
    // The last write wins: the update is not shown after the user's edit.
    expect(onSave.mock.calls).toEqual([["Old notes and local edits"]]);
    await waitFor(() => expect(saveState()).toBe("Saved"));
    await focusDocumentation();
    await blurDocumentation();
    expect(documentation().textContent).toBe("Old notes and local edits");
  });

  it("recognizes its own save coming back before the save finishes", async () => {
    const { onSave, finish } = pendingSaves();
    const { rerender } = renderWithQuery(<RichDocumentation value="Notes" onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), " v2");
    await blurDocumentation();
    rerender(<RichDocumentation value="Notes v2" onSave={onSave} />);
    await act(async () => finish[0]());
    expect(saveState()).toBe("Saved");

    // A later change elsewhere, back to the old documentation, is still shown.
    rerender(<RichDocumentation value="Notes" onSave={onSave} />);
    expect(documentation().textContent).toBe("Notes");
    expect(onSave.mock.calls).toEqual([["Notes v2"]]);
  });

  it("keeps unsaved changes when documentation is updated elsewhere", async () => {
    const onSave = mock(async (_value: string) => {
      throw new Error("Network unavailable");
    });
    const { rerender } = renderWithQuery(<RichDocumentation value="Old notes" onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), " and local edits");
    await blurDocumentation();
    expect((await screen.findByRole("alert")).textContent).toContain("Network unavailable");

    rerender(<RichDocumentation value="Remote notes" onSave={onSave} />);
    expect(documentation().textContent).toBe("Old notes and local edits");
    expect(saveState()).toBe("Unsaved changes");
  });

  it("keeps its undo history when its own save comes back as the documentation", async () => {
    const onSave = mock(async (_value: string) => {});
    const { rerender } = renderWithQuery(<RichDocumentation value="Notes" onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), " v2");
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([["Notes v2"]]);
    rerender(<RichDocumentation value="Notes v2" onSave={onSave} />);

    act(() => {
      editorFromElement(documentation()).commands.undo();
    });
    expect(documentation().textContent).toBe("Notes");
    expect(saveState()).toBe("Unsaved changes");
  });

  it("saves a pending edit when the editor closes before the autosave", async () => {
    const onSave = mock(async (_value: string) => {});
    const { unmount } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    await typeInEditor(documentation(), "Closing soon");
    expect(onSave).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(onSave.mock.calls).toEqual([["Closing soon"]]));
  });

  it("saves a pending edit once on close under StrictMode", async () => {
    const onSave = mock(async (_value: string) => {});
    const { unmount } = renderWithQuery(
      <StrictMode>
        <RichDocumentation value="Notes" onSave={onSave} />
      </StrictMode>,
    );
    await caretToEnd();
    await typeInEditor(documentation(), " v2");
    unmount();
    await waitFor(() => expect(onSave.mock.calls).toEqual([["Notes v2"]]));
  });

  it("leaves the editor on Escape and saves", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    await typeInEditor(documentation(), "Escape hatch");
    await actor.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).not.toBe(documentation()));
    await waitFor(() => expect(onSave.mock.calls).toEqual([["Escape hatch"]]));
  });

  it("leaves the editor on an Escape that a dialog has already prevented", async () => {
    // The details dialog prevents Escape on the document, before the editor sees it, to stay open while editing.
    const preventEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", preventEscape, { capture: true });
    try {
      const onSave = mock(async (_value: string) => {});
      const { user: actor } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
      await typeInEditor(documentation(), "Inside a dialog");
      await actor.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).not.toBe(documentation()));
      await waitFor(() => expect(onSave.mock.calls).toEqual([["Inside a dialog"]]));
    } finally {
      document.removeEventListener("keydown", preventEscape, { capture: true });
    }
  });

  it("does not send documentation over 20,000 characters of Markdown", async () => {
    const limitMessage = "Documentation is limited to 20,000 characters of Markdown. Shorten it to save.";
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value={"a".repeat(19_999)} onSave={onSave} />);
    await caretToEnd();
    await typeInEditor(documentation(), "bc");
    await blurDocumentation();
    expect(screen.getByRole("alert").textContent).toContain(limitMessage);
    expect(saveState()).toBe("Unsaved changes");
    expect(documentation().textContent).toHaveLength(20_001);

    await actor.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("alert").textContent).toContain(limitMessage);
    expect(onSave).not.toHaveBeenCalled();

    await caretToEnd();
    await focusDocumentation();
    await actor.keyboard("{Backspace}");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await blurDocumentation();
    expect(onSave.mock.calls).toEqual([[`${"a".repeat(19_999)}b`]]);
  });
});

describe("editable database schema", () => {
  it("draws tables from SQL and saves the schema", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<DatabaseSchema value="" onSave={onSave} />);
    expect(screen.getByText("Add CREATE TABLE statements to see a relationship diagram.")).toBeTruthy();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save schema" });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("SQL schema"), { target: { value: ordersSql } });
    expect(screen.getByText("2 tables · 1 relationships")).toBeTruthy();
    expect(await screen.findByText("customer_id")).toBeTruthy();
    await actor.click(save);
    expect(onSave).toHaveBeenCalledWith(ordersSql);
  });

  it("reverts unsaved SQL on Escape and shows save errors", async () => {
    const onSave = mock(async (_value: string) => {
      throw new Error("Schema is too large");
    });
    const { user: actor } = renderWithQuery(<DatabaseSchema value="CREATE TABLE a (id INT);" onSave={onSave} />);
    const sql = screen.getByLabelText<HTMLTextAreaElement>("SQL schema");
    await actor.type(sql, " --");
    await actor.keyboard("{Escape}");
    expect(sql.value).toBe("CREATE TABLE a (id INT);");

    await actor.type(sql, " --");
    await actor.click(screen.getByRole("button", { name: "Save schema" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Schema is too large");
  });

  it("keeps local edits when the saved schema changes elsewhere", () => {
    const { rerender } = renderWithQuery(<DatabaseSchema value="CREATE TABLE a (id INT);" onSave={async () => {}} />);
    fireEvent.change(screen.getByLabelText("SQL schema"), { target: { value: "local" } });
    rerender(<DatabaseSchema value="CREATE TABLE b (id INT);" onSave={async () => {}} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>("SQL schema").value).toBe("local");
  });
});

describe("shortcut labels", () => {
  it("detects Apple platforms from the browser", () => {
    expect(isApplePlatform("MacIntel Mozilla/5.0")).toBe(true);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(typeof isApplePlatform()).toBe("boolean");
    expect(canvasShortcutLabel("undo", false)).toBe("Ctrl+Z");
  });
});
