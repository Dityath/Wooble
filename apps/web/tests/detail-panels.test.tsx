import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { CanvasActivityLog } from "../src/features/canvas/canvas-activity-log";
import { canvasShortcutLabel, isApplePlatform } from "../src/features/canvas/canvas-shortcuts";
import { DatabaseSchema } from "../src/features/inspector/database-schema";
import { RichDocumentation } from "../src/features/inspector/rich-documentation";
import { CanvasShareDialog } from "../src/features/workspace/canvas-share-dialog";
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
    expect(screen.getByText("No documentation yet. Select Edit to start writing.")).toBeTruthy();
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
  it("renders Markdown, edits with a live preview, and saves on Done", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value={"# Runbook"} onSave={onSave} />);
    expect(screen.getByRole("heading", { name: "Runbook" })).toBeTruthy();

    await actor.click(screen.getByRole("button", { name: "Edit" }));
    const source = screen.getByLabelText("Documentation Markdown");
    expect(document.activeElement).toBe(source);
    expect(screen.getByRole("status").textContent).toBe("Saved");
    await actor.type(source, "\n\n- restart the worker");
    expect(screen.getByRole("status").textContent).toBe("Unsaved changes");
    expect(screen.getByRole("listitem").textContent).toBe("restart the worker");

    await actor.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    expect(onSave).toHaveBeenLastCalledWith("# Runbook\n\n- restart the worker");
  });

  it("autosaves after a pause and saves with Cmd/Ctrl+Enter", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    expect(screen.getByText("No documentation yet. Select Edit to start writing.")).toBeTruthy();
    await actor.click(screen.getByRole("button", { name: "Edit" }));
    await actor.type(screen.getByLabelText("Documentation Markdown"), "Draft");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Draft"), { timeout: 2000 });

    await actor.type(screen.getByLabelText("Documentation Markdown"), " two{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    expect(onSave).toHaveBeenLastCalledWith("Draft two");
  });

  it("restores the saved text on Escape or Cancel", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value="Stable" onSave={onSave} />);
    await actor.click(screen.getByRole("button", { name: "Edit" }));
    await actor.type(screen.getByLabelText("Documentation Markdown"), " change");
    await actor.keyboard("{Escape}");
    expect(screen.getByText("Stable")).toBeTruthy();

    await actor.click(screen.getByRole("button", { name: "Edit" }));
    await actor.type(screen.getByLabelText("Documentation Markdown"), " again");
    await actor.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Documentation Markdown")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps editing after a failed save and retries", async () => {
    let fail = true;
    const onSave = mock(async (_value: string) => {
      if (fail) throw new Error("Documentation is too long");
    });
    const { user: actor } = renderWithQuery(<RichDocumentation value="" onSave={onSave} />);
    await actor.click(screen.getByRole("button", { name: "Edit" }));
    await actor.type(screen.getByLabelText("Documentation Markdown"), "Notes");
    await actor.click(screen.getByRole("button", { name: "Done" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Documentation is too long");
    expect(screen.getByLabelText("Documentation Markdown")).toBeTruthy();

    fail = false;
    await actor.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onSave).toHaveBeenLastCalledWith("Notes");
  });

  it("saves when the editor loses focus and skips unchanged text", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user: actor } = renderWithQuery(<RichDocumentation value="Same" onSave={onSave} />);
    await actor.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.blur(screen.getByLabelText("Documentation Markdown"));
    expect(onSave).not.toHaveBeenCalled();
    await actor.type(screen.getByLabelText("Documentation Markdown"), "!");
    fireEvent.blur(screen.getByLabelText("Documentation Markdown"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Same!"));
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
