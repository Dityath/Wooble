import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { FakeApi, failWith } from "./support/fake-api";
import { canvasSummary, graph, ids, member, user, workspace } from "./support/fixtures";
import { renderRoute } from "./support/render";

let server: FakeApi;

beforeEach(() => {
  server = new FakeApi()
    .install()
    .on("GET /api/auth/me", user())
    .on("GET /api/workspaces", [workspace()])
    .on("GET /api/canvases", [canvasSummary()])
    .on("GET /api/workspaces/:id", workspace())
    .on("GET /api/workspaces/:id/members", [member({ id: ids.user, name: "Ada Lovelace", role: "manager" }), member()]);
});
afterEach(() => server.restore());

async function openPeopleTab(actor: Awaited<ReturnType<typeof renderRoute>>["user"]) {
  await actor.click(await screen.findByRole("tab", { name: "People" }));
  return screen.findByRole("heading", { name: "People in workspace" });
}

describe("workspace settings", () => {
  it("edits the workspace details and can cancel an edit", async () => {
    server.on("PATCH /api/workspaces/:id", ({ body }) => workspace(body as object));
    const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
    expect(await screen.findByRole("heading", { level: 1, name: "Payments" })).toBeTruthy();
    expect(screen.getByText("Checkout and billing")).toBeTruthy();

    await actor.click(screen.getByRole("button", { name: /Edit/ }));
    await actor.click(screen.getByRole("button", { name: "Cancel" }));
    expect(server.requests("PATCH", `/api/workspaces/${ids.workspace}`)).toEqual([]);

    await actor.click(screen.getByRole("button", { name: /Edit/ }));
    const name = screen.getByLabelText("Name");
    await actor.clear(name);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
    await actor.type(name, " Payments Core ");
    await actor.clear(screen.getByLabelText("Description"));
    await actor.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    expect(server.requests("PATCH", `/api/workspaces/${ids.workspace}`)[0].body).toEqual({
      name: "Payments Core",
      description: "",
    });
  });

  it("keeps the form open with the error when saving fails", async () => {
    server.on("PATCH /api/workspaces/:id", failWith(409, "Name already used"));
    const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
    await actor.click(await screen.findByRole("button", { name: /Edit/ }));
    await actor.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name already used");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("adds, re-roles, and removes members without offering to edit yourself", async () => {
    server
      .on("POST /api/workspaces/:id/members", member({ id: "new" }))
      .on("PATCH /api/workspaces/:id/members/:userId", member({ role: "manager" }))
      .on("DELETE /api/workspaces/:id/members/:userId", { ok: true });
    const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
    await openPeopleTab(actor);

    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.queryByLabelText("Role for Ada Lovelace")).toBeNull();

    await actor.type(screen.getByPlaceholderText("Registered user's email"), "linus@example.test");
    await actor.selectOptions(screen.getByLabelText("Workspace role"), "manager");
    await actor.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() =>
      expect(server.requests("POST", `/api/workspaces/${ids.workspace}/members`)[0]?.body).toEqual({
        email: "linus@example.test",
        role: "manager",
      }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText<HTMLInputElement>("Registered user's email").value).toBe(""),
    );

    await actor.selectOptions(screen.getByLabelText("Role for Grace Hopper"), "manager");
    await waitFor(() =>
      expect(server.requests("PATCH", `/api/workspaces/${ids.workspace}/members/${ids.otherUser}`)[0]?.body).toEqual({
        role: "manager",
      }),
    );

    await actor.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(server.requests("DELETE", `/api/workspaces/${ids.workspace}/members/${ids.otherUser}`)).toHaveLength(1),
    );
  });

  it("reports member changes the API rejects", async () => {
    server
      .on("POST /api/workspaces/:id/members", failWith(404, "No registered user with that email"))
      .on("PATCH /api/workspaces/:id/members/:userId", failWith(409, "A workspace needs a manager"))
      .on("DELETE /api/workspaces/:id/members/:userId", failWith(409, "Cannot remove the last manager"));
    const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
    await openPeopleTab(actor);
    await actor.type(screen.getByPlaceholderText("Registered user's email"), "nobody@example.test");
    await actor.click(screen.getByRole("button", { name: /Add/ }));
    expect((await screen.findByRole("status")).textContent).toBe("No registered user with that email");

    await actor.selectOptions(await screen.findByLabelText("Role for Grace Hopper"), "manager");
    expect((await screen.findByRole("alert")).textContent).toBe("A workspace needs a manager");
    await actor.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Cannot remove the last manager"));
  });

  it("creates a one-use invitation link and copies it", async () => {
    server.on("POST /api/workspaces/:id/invitations", { token: "invite-token" });
    const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
      await openPeopleTab(actor);
      await actor.click(screen.getByRole("button", { name: /Create workspace link/ }));
      const link = await screen.findByLabelText<HTMLInputElement>("Invitation link");
      expect(link.value).toBe("http://localhost:5173/invite/invite-token");
      await actor.click(screen.getByRole("button", { name: "Copy" }));
      expect(copy).toHaveBeenCalledWith("http://localhost:5173/invite/invite-token");
    } finally {
      copy.mockRestore();
    }
  });

  it("shows an invitation error", async () => {
    server.on("POST /api/workspaces/:id/invitations", failWith(429, "Too many invitations"));
    const { user: actor } = await renderRoute(`/workspaces/${ids.workspace}/settings`);
    await openPeopleTab(actor);
    await actor.click(screen.getByRole("button", { name: /Create workspace link/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many invitations");
  });

  it("hides management from members and shows load errors", async () => {
    server.on("GET /api/workspaces/:id", workspace({ role: "member" }));
    await renderRoute(`/workspaces/${ids.workspace}/settings`);
    expect(await screen.findByRole("heading", { level: 1, name: "Payments" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();

    server.on("GET /api/workspaces/:id", failWith(404, "Workspace not found"));
    await renderRoute(`/workspaces/${ids.workspace}/settings`);
    expect((await screen.findByRole("alert")).textContent).toBe("Workspace not found");
  });
});

describe("new workspace", () => {
  it("creates a workspace and opens its canvases", async () => {
    server.on("POST /api/workspaces", workspace({ id: ids.otherWorkspace, name: "Platform" }));
    const { user: actor, router } = await renderRoute("/workspaces/new");
    await actor.type(await screen.findByLabelText("Name"), "Platform");
    await actor.type(screen.getByLabelText("Description"), "Shared services");
    await actor.click(screen.getByRole("button", { name: /Create workspace/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspaceId: ids.otherWorkspace }));
    expect(server.requests("POST", "/api/workspaces")[0].body).toEqual({
      name: "Platform",
      description: "Shared services",
    });
  });

  it("shows why a workspace could not be created", async () => {
    server.on("POST /api/workspaces", failWith(400, "Name is too long"));
    const { user: actor } = await renderRoute("/workspaces/new");
    await actor.type(await screen.findByLabelText("Name"), "Platform");
    await actor.click(screen.getByRole("button", { name: /Create workspace/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name is too long");
  });

  it("offers workspace creation to people without access", async () => {
    await renderRoute("/no-workspace");
    expect(await screen.findByRole("heading", { name: "No workspace access" })).toBeTruthy();
    expect(
      within(screen.getByRole("main"))
        .getByRole("link", { name: /Create workspace/ })
        .getAttribute("href"),
    ).toBe("/workspaces/new");
  });
});

describe("canvas settings", () => {
  beforeEach(() => {
    server
      .on("GET /api/canvases/:id", graph().canvas)
      .on("GET /api/canvases/:id/access", { role: "manager" })
      .on("GET /api/canvases/:id/members", [member({ role: "viewer" })]);
  });

  it("renames the canvas", async () => {
    server.on("PATCH /api/canvases/:id", ({ body }) => ({ ...graph().canvas, ...(body as object) }));
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}/manage`);
    expect(await screen.findByRole("heading", { level: 1, name: "Checkout flow" })).toBeTruthy();
    await actor.click(await screen.findByRole("button", { name: /Edit/ }));
    await actor.clear(screen.getByLabelText("Name"));
    await actor.type(screen.getByLabelText("Name"), "Checkout v2");
    await actor.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(server.requests("PATCH", `/api/canvases/${ids.canvas}`)[0]?.body).toEqual({
        name: "Checkout v2",
        description: "Order placement",
      }),
    );
  });

  it("manages canvas members and link invitations", async () => {
    server
      .on("POST /api/canvases/:id/members", member({ role: "editor" }))
      .on("PATCH /api/canvases/:id/members/:userId", member({ role: "editor" }))
      .on("DELETE /api/canvases/:id/members/:userId", { ok: true })
      .on("POST /api/canvases/:id/invitations", { token: "canvas-token" });
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}/manage`);
    await actor.type(await screen.findByPlaceholderText("Registered user's email"), "grace@example.test");
    await actor.selectOptions(screen.getByLabelText("Canvas role"), "editor");
    await actor.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() =>
      expect(server.requests("POST", `/api/canvases/${ids.canvas}/members`)[0]?.body).toEqual({
        email: "grace@example.test",
        role: "editor",
      }),
    );

    await actor.selectOptions(await screen.findByLabelText("Role for Grace Hopper"), "editor");
    await actor.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(server.requests("DELETE", `/api/canvases/${ids.canvas}/members/${ids.otherUser}`)).toHaveLength(1),
    );
    expect(server.requests("PATCH", `/api/canvases/${ids.canvas}/members/${ids.otherUser}`)[0].body).toEqual({
      role: "editor",
    });

    await actor.selectOptions(screen.getByLabelText("Invitation role"), "editor");
    await actor.click(screen.getByRole("button", { name: /Create canvas link/ }));
    expect((await screen.findByLabelText<HTMLInputElement>("Invitation link")).value).toContain("/invite/canvas-token");
    expect(server.requests("POST", `/api/canvases/${ids.canvas}/invitations`)[0].body).toEqual({ role: "editor" });
  });

  it("reports a rejected canvas member", async () => {
    server.on("POST /api/canvases/:id/members", failWith(400, "Already a member"));
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}/manage`);
    await actor.type(await screen.findByPlaceholderText("Registered user's email"), "grace@example.test");
    await actor.click(screen.getByRole("button", { name: /Add/ }));
    expect((await screen.findByRole("status")).textContent).toBe("Already a member");
  });

  it("deletes the canvas after confirmation", async () => {
    server.on("DELETE /api/canvases/:id", { ok: true });
    const { user: actor, router } = await renderRoute(`/canvases/${ids.canvas}/manage`);
    await actor.click(await screen.findByRole("button", { name: /Delete canvas/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete canvas?" });
    expect(within(dialog).getByText(/“Checkout flow”/)).toBeTruthy();
    await actor.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await actor.click(screen.getByRole("button", { name: /Delete canvas/ }));
    await actor.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Delete canvas/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/canvases"));
    expect(server.requests("DELETE", `/api/canvases/${ids.canvas}`)).toHaveLength(1);
  });

  it("keeps the confirmation open when deletion fails", async () => {
    server.on("DELETE /api/canvases/:id", failWith(409, "Canvas changed"));
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}/manage`);
    await actor.click(await screen.findByRole("button", { name: /Delete canvas/ }));
    const dialog = await screen.findByRole("dialog");
    await actor.click(within(dialog).getByRole("button", { name: /Delete canvas/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Canvas changed");
  });

  it("tells non-managers that access is required", async () => {
    server.on("GET /api/canvases/:id/access", { role: "editor" });
    await renderRoute(`/canvases/${ids.canvas}/manage`);
    expect(await screen.findByRole("heading", { name: "Manager access required" })).toBeTruthy();
    expect(server.requests("GET", `/api/canvases/${ids.canvas}/members`)).toEqual([]);
  });

  it("shows load errors", async () => {
    server.on("GET /api/canvases/:id/access", failWith(403, "No access to this canvas"));
    await renderRoute(`/canvases/${ids.canvas}/manage`);
    expect((await screen.findByRole("alert")).textContent).toBe("No access to this canvas");
  });
});
