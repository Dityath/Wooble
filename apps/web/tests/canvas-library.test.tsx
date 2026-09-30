import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { FakeApi, failWith } from "./support/fake-api";
import { canvasSummary, ids, user, workspace } from "./support/fixtures";
import { renderRoute } from "./support/render";

let server: FakeApi;

beforeEach(() => {
  server = new FakeApi()
    .install()
    .on("GET /api/auth/me", user())
    .on("GET /api/workspaces", [workspace({ id: ids.otherWorkspace, name: "Research", role: "member" }), workspace()])
    .on("GET /api/canvases", [
      canvasSummary({ name: "Checkout flow", updatedAt: "2026-09-02T00:00:00.000Z" }),
      canvasSummary({
        id: ids.otherCanvas,
        name: "Billing",
        description: "Invoices and refunds",
        updatedAt: "2026-09-05T00:00:00.000Z",
        systemCount: 2,
        serviceCount: 1,
      }),
      canvasSummary({
        id: "20000000-0000-4000-8000-000000000009",
        workspaceId: ids.otherWorkspace,
        name: "Lab notes",
      }),
    ]);
});
afterEach(() => server.restore());

const cardTitles = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

describe("canvas library", () => {
  it("lists the managed workspace's canvases, newest first, with counts", async () => {
    await renderRoute("/canvases");
    expect(await screen.findByText("View and manage the maps in Payments.")).toBeTruthy();
    await waitFor(() => expect(cardTitles()).toEqual(["Billing", "Checkout flow"]));
    const billing = within(screen.getByRole("main")).getByRole("link", { name: /Billing/ });
    expect(billing.getAttribute("href")).toBe(`/canvases/${ids.otherCanvas}`);
    expect(within(billing).getByText("2 systems")).toBeTruthy();
    expect(within(billing).getByText("1 service")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new canvas/i })).toBeTruthy();
  });

  it("searches by name or description and sorts by name", async () => {
    const { user: actor } = await renderRoute("/canvases");
    const search = await screen.findByRole("textbox", { name: "Search canvases" });
    await actor.type(search, "refund");
    expect(cardTitles()).toEqual(["Billing"]);

    await actor.clear(search);
    await actor.type(search, "nothing like this");
    expect(screen.getByRole("heading", { name: "No matching canvases" })).toBeTruthy();
    const [clearIcon, clearButton] = screen.getAllByRole("button", { name: "Clear search" });
    expect(clearIcon.textContent).toBe("");
    await actor.click(clearButton);
    expect(cardTitles()).toEqual(["Billing", "Checkout flow"]);

    await actor.type(search, "order");
    expect(cardTitles()).toEqual(["Checkout flow"]);
    await actor.click(screen.getByRole("button", { name: "Clear search" }));
    expect((search as HTMLInputElement).value).toBe("");

    await actor.selectOptions(screen.getByRole("combobox"), "name");
    expect(cardTitles()).toEqual(["Billing", "Checkout flow"].sort());
  });

  it("opens the workspace named in the URL", async () => {
    await renderRoute(`/canvases?workspaceId=${ids.otherWorkspace}`);
    expect(await screen.findByText("View and manage the maps in Research.")).toBeTruthy();
    await waitFor(() => expect(cardTitles()).toEqual(["Lab notes"]));
    expect(screen.queryByRole("button", { name: /new canvas/i })).toBeNull();
  });

  it("creates a canvas and opens it", async () => {
    server.on("POST /api/canvases", ({ body }) => canvasSummary({ id: ids.otherCanvas, ...(body as object) }));
    const { user: actor, router } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: /new canvas/i }));
    const dialog = await screen.findByRole("dialog", { name: "New canvas" });
    const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: /create canvas/i });
    expect(submit.disabled).toBe(true);

    await actor.type(within(dialog).getByLabelText("Canvas name"), "  Fulfilment  ");
    await actor.type(within(dialog).getByLabelText(/Description/), " Warehouses ");
    await actor.click(submit);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/canvases/${ids.otherCanvas}`));
    expect(server.requests("POST", "/api/canvases")[0].body).toEqual({
      workspaceId: ids.workspace,
      name: "Fulfilment",
      description: "Warehouses",
    });
  });

  it("keeps the dialog open with the error when creation fails, and cancels", async () => {
    server.on("POST /api/canvases", failWith(403, "Only managers can create canvases"));
    const { user: actor } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: /new canvas/i }));
    const dialog = await screen.findByRole("dialog");
    await actor.type(within(dialog).getByLabelText("Canvas name"), "Fulfilment");
    await actor.click(within(dialog).getByRole("button", { name: /create canvas/i }));
    expect(await within(dialog).findByText("Only managers can create canvases")).toBeTruthy();

    await actor.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("invites a manager of an empty workspace to create the first canvas", async () => {
    server.on("GET /api/canvases", []);
    const { user: actor } = await renderRoute("/canvases");
    expect(await screen.findByRole("heading", { name: "Start with a canvas" })).toBeTruthy();
    await actor.click(screen.getByRole("button", { name: /new canvas/i }));
    expect(await screen.findByRole("dialog", { name: "New canvas" })).toBeTruthy();
  });

  it("tells a member when nothing has been shared yet", async () => {
    server.on("GET /api/workspaces", [workspace({ role: "member" })]).on("GET /api/canvases", []);
    await renderRoute("/canvases");
    expect(await screen.findByRole("heading", { name: "No canvases shared yet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new canvas/i })).toBeNull();
  });

  it("shows a load error and retries", async () => {
    server.on("GET /api/canvases", failWith(500, "Database unavailable"));
    const { user: actor } = await renderRoute("/canvases");
    expect(await screen.findByText("Database unavailable")).toBeTruthy();
    server.on("GET /api/canvases", [canvasSummary()]);
    await actor.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cardTitles()).toEqual(["Checkout flow"]));
  });

  it("sends people without a workspace to the no-workspace page", async () => {
    server.on("GET /api/workspaces", []).on("GET /api/canvases", []);
    const { router } = await renderRoute("/canvases");
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-workspace"));
  });

  it("shows a fallback date when the update time is unreadable", async () => {
    server.on("GET /api/canvases", [canvasSummary({ updatedAt: "not a date", systemCount: 1, serviceCount: 3 })]);
    await renderRoute("/canvases");
    expect(await screen.findByText("Recently")).toBeTruthy();
    expect(screen.getByText("1 system")).toBeTruthy();
    expect(screen.getByText("3 services")).toBeTruthy();
  });
});

describe("app shell", () => {
  it("shows the account menu, admin link for admins, and closes on Escape or outside click", async () => {
    server.on("GET /api/auth/me", user({ systemRole: "admin" }));
    const { user: actor } = await renderRoute("/canvases");
    const trigger = await screen.findByRole("button", { name: "Open account menu" });
    await waitFor(() => expect(trigger.textContent).toBe("A"));

    await actor.click(trigger);
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(screen.getByRole("link", { name: /System admin/ }).getAttribute("href")).toBe("/admin/users");
    await actor.keyboard("{Escape}");
    expect(screen.queryByText("ada@example.test")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await actor.click(trigger);
    await actor.click(screen.getByRole("heading", { name: "Your canvases" }));
    expect(screen.queryByText("ada@example.test")).toBeNull();
  });

  it("hides the admin link from regular accounts and opens the profile", async () => {
    const { user: actor, router } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: "Open account menu" }));
    expect(screen.queryByRole("link", { name: /System admin/ })).toBeNull();
    server.on("GET /api/auth/me", user());
    await actor.click(screen.getByRole("link", { name: /Profile/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profile"));
  });

  it("signs out and returns to the login page", async () => {
    server.on("POST /api/auth/logout", { ok: true });
    const { user: actor, router } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: "Open account menu" }));
    await actor.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(server.requests("POST", "/api/auth/logout")).toHaveLength(1);
  });

  it("reports a failed sign-out", async () => {
    server.on("POST /api/auth/logout", failWith(503, "Service unavailable"));
    const { user: actor } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: "Open account menu" }));
    await actor.click(screen.getByRole("button", { name: /Sign out/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Service unavailable");
  });

  it("switches workspaces from the workspace menu", async () => {
    const { user: actor, router } = await renderRoute("/canvases");
    const trigger = await screen.findByRole("button", { name: "Choose workspace" });
    await waitFor(() => expect(within(trigger).getByText("Payments")).toBeTruthy());
    await actor.click(trigger);
    const panel = document.getElementById("workspace-menu-panel") as HTMLElement;
    expect(within(panel).getByText("Current").closest("a")?.textContent).toContain("Payments");
    expect(
      within(panel)
        .getByRole("link", { name: /Create workspace/ })
        .getAttribute("href"),
    ).toBe("/workspaces/new");

    await actor.click(within(panel).getByRole("link", { name: /Research/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspaceId: ids.otherWorkspace }));
    expect(document.getElementById("workspace-menu-panel")).toBeNull();
    await actor.click(trigger);
    await actor.keyboard("{Escape}");
    expect(document.getElementById("workspace-menu-panel")).toBeNull();
  });

  it("lists recent canvases and the manage link for managers", async () => {
    await renderRoute("/canvases");
    const recent = await screen.findByRole("navigation", { name: "Recent canvases" });
    await waitFor(() => expect(within(recent).getAllByRole("link")).toHaveLength(2));
    expect(screen.getByRole("link", { name: /Manage workspace/ }).getAttribute("href")).toBe(
      `/workspaces/${ids.workspace}/settings`,
    );
  });

  it("opens and closes the mobile navigation", async () => {
    const { user: actor } = await renderRoute("/canvases");
    await actor.click(await screen.findByRole("button", { name: "Open navigation" }));
    expect(document.getElementById("app-sidebar")?.className).toContain("sidebar-open");
    await actor.keyboard("{Escape}");
    expect(document.getElementById("app-sidebar")?.className).not.toContain("sidebar-open");

    await actor.click(screen.getByRole("button", { name: "Open navigation" }));
    const [, scrim] = screen.getAllByRole("button", { name: "Close navigation" });
    await actor.click(scrim);
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeTruthy();
  });
});

describe("routing", () => {
  it("sends the root path to the canvas library", async () => {
    const { router } = await renderRoute("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases"));
  });

  it("redirects a workspace link to its canvases", async () => {
    const { router } = await renderRoute(`/workspaces/${ids.otherWorkspace}`);
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases"));
    expect(router.state.location.search).toEqual({ workspaceId: ids.otherWorkspace });
  });

  it("asks signed-out visitors to sign in and remembers where they were going", async () => {
    server.on("GET /api/auth/me", failWith(401, "Sign in required"));
    const { router } = await renderRoute("/profile");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ returnTo: "/profile" });
  });

  it("shows a retryable error page when the API is unavailable", async () => {
    server.on("GET /api/auth/me", failWith(502, "Bad gateway"));
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      const { user: actor } = await renderRoute("/profile");
      expect(await screen.findByRole("heading", { name: "We couldn't load this page" })).toBeTruthy();
      await actor.click(screen.getByRole("button", { name: /Try again/ }));
      expect(reload).toHaveBeenCalled();
    } finally {
      reload.mockRestore();
    }
  });

  it("explains a forbidden page without offering a retry", async () => {
    server.on("GET /api/auth/me", failWith(403, "Forbidden"));
    await renderRoute("/admin/users");
    expect(await screen.findByRole("heading", { name: "You can't open this page" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to canvases" })).toBeTruthy();
  });
});
