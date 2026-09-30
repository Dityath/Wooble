import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { FakeApi, failWith } from "./support/fake-api";
import { canvasSummary, ids, user, workspace } from "./support/fixtures";
import { renderRoute } from "./support/render";

let server: FakeApi;

beforeEach(() => {
  server = new FakeApi()
    .install()
    .on("GET /api/auth/me", user())
    .on("GET /api/workspaces", [workspace()])
    .on("GET /api/canvases", [canvasSummary()]);
});
afterEach(() => server.restore());

describe("profile", () => {
  it("renames the account and confirms the update", async () => {
    server.on("PATCH /api/auth/profile", ({ body }) => user({ name: (body as { name: string }).name }));
    const { user: actor } = await renderRoute("/profile");
    await actor.click(await screen.findByRole("button", { name: /Edit profile/ }));
    const name = screen.getByLabelText<HTMLInputElement>("Name");
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" });
    expect(name.value).toBe("Ada Lovelace");
    expect(save.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Change password/ }).disabled).toBe(true);

    await actor.clear(name);
    await actor.type(name, "A");
    expect(save.disabled).toBe(true);
    await actor.type(name, "da King ");
    await actor.click(save);

    expect((await screen.findByRole("status")).textContent).toBe("Profile updated.");
    expect(screen.getAllByText("Ada King").length).toBeGreaterThan(0);
    expect(server.requests("PATCH", "/api/auth/profile")[0].body).toEqual({ name: "Ada King" });
  });

  it("shows a profile save error and cancels editing", async () => {
    server.on("PATCH /api/auth/profile", failWith(400, "Name is not allowed"));
    const { user: actor } = await renderRoute("/profile");
    await actor.click(await screen.findByRole("button", { name: /Edit profile/ }));
    await actor.type(screen.getByLabelText("Name"), " II");
    await actor.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name is not allowed");
    await actor.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: /Edit profile/ })).toBeTruthy();
  });

  it("switches the color theme", async () => {
    const { user: actor } = await renderRoute("/profile");
    const dark = await screen.findByRole("button", { name: /Dark/ });
    expect(screen.getByRole("button", { name: /Light/ }).getAttribute("aria-pressed")).toBe("true");
    await actor.click(dark);
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await actor.click(screen.getByRole("button", { name: /Light/ }));
    expect(localStorage.getItem("wooble-theme")).toBe("light");
  });

  it("changes the password and signs the user out", async () => {
    server.on("PUT /api/auth/password", { ok: true });
    const { user: actor, router } = await renderRoute("/profile");
    await actor.click(await screen.findByRole("button", { name: /Change password/ }));
    const submit = screen.getAllByRole<HTMLButtonElement>("button", { name: "Change password" }).at(-1);
    await actor.type(screen.getByLabelText("Current password"), "old-password");
    await actor.type(screen.getByLabelText("New password"), "too-short");
    expect(submit?.disabled).toBe(true);
    await actor.type(screen.getByLabelText("New password"), "-but-now-long");
    await actor.click(submit as HTMLButtonElement);

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(server.requests("PUT", "/api/auth/password")[0].body).toEqual({
      currentPassword: "old-password",
      newPassword: "too-short-but-now-long",
    });
  });

  it("keeps the password form open on error and clears it on cancel", async () => {
    server.on("PUT /api/auth/password", failWith(401, "Current password is incorrect"));
    const { user: actor } = await renderRoute("/profile");
    await actor.click(await screen.findByRole("button", { name: /Change password/ }));
    await actor.type(screen.getByLabelText("Current password"), "wrong-password");
    await actor.type(screen.getByLabelText("New password"), "a-new-long-password");
    await actor.click(screen.getAllByRole("button", { name: "Change password" }).at(-1) as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toBe("Current password is incorrect");

    await actor.click(screen.getByRole("button", { name: "Cancel" }));
    await actor.click(screen.getByRole("button", { name: /Change password/ }));
    expect(screen.getByLabelText<HTMLInputElement>("Current password").value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a retry when the profile cannot load", async () => {
    // The route guard's session check passes; the profile query that follows fails until retried.
    let calls = 0;
    let available = false;
    server.on("GET /api/auth/me", () => (++calls === 1 || available ? user() : failWith(503, "Profile service down")));
    const { user: actor } = await renderRoute("/profile");
    expect((await screen.findByRole("alert")).textContent).toBe("Profile service down");
    available = true;
    await actor.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Personal details" })).toBeTruthy();
  });
});

describe("system admin", () => {
  const people = [
    user({ systemRole: "admin" }),
    user({ id: ids.otherUser, name: "Grace Hopper", email: "g@example.test" }),
  ];

  it("promotes a user and refreshes the list", async () => {
    let list = people;
    server
      .on("GET /api/admin/users", () => list)
      .on("PATCH /api/admin/users/:id", ({ params, body }) => {
        list = list.map((person) => (person.id === params.id ? { ...person, ...(body as object) } : person));
        return list.find((person) => person.id === params.id);
      });
    const { user: actor } = await renderRoute("/admin/users");
    const role = await screen.findByLabelText<HTMLSelectElement>("System role for Grace Hopper");
    expect(role.value).toBe("user");
    await actor.selectOptions(role, "admin");
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>("System role for Grace Hopper").value).toBe("admin"),
    );
    expect(server.requests("PATCH", `/api/admin/users/${ids.otherUser}`)[0].body).toEqual({ systemRole: "admin" });
  });

  it("shows role update and load errors", async () => {
    server
      .on("GET /api/admin/users", people)
      .on("PATCH /api/admin/users/:id", failWith(409, "Keep at least one admin"));
    const { user: actor } = await renderRoute("/admin/users");
    await actor.selectOptions(await screen.findByLabelText("System role for Ada Lovelace"), "user");
    expect((await screen.findByRole("alert")).textContent).toBe("Keep at least one admin");
  });

  it("shows why the user list could not load", async () => {
    server.on("GET /api/admin/users", failWith(403, "Admins only"));
    await renderRoute("/admin/users");
    expect((await screen.findByRole("alert")).textContent).toBe("Admins only");
  });
});

describe("invitations", () => {
  it("joins a canvas from its invitation", async () => {
    server
      .on("GET /api/invitations/:token", {
        workspaceName: "Payments",
        canvasName: "Checkout flow",
        role: "viewer",
        expiresAt: "2026-10-01T00:00:00.000Z",
      })
      .on("POST /api/invitations/:token/accept", { workspaceId: ids.workspace, canvasId: ids.canvas });
    const { user: actor, router } = await renderRoute("/invite/abc");
    expect(await screen.findByRole("heading", { name: "Join Checkout flow" })).toBeTruthy();
    expect(screen.getByText("You'll join Payments with viewer access to this canvas.")).toBeTruthy();
    await actor.click(screen.getByRole("button", { name: /Accept invitation/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/canvases/${ids.canvas}`));
  });

  it("joins a workspace and opens its canvases", async () => {
    server
      .on("GET /api/invitations/:token", { workspaceName: "Payments", role: "member", expiresAt: "x" })
      .on("POST /api/invitations/:token/accept", { workspaceId: ids.workspace, canvasId: null });
    const { user: actor, router } = await renderRoute("/invite/abc");
    expect(await screen.findByRole("heading", { name: "Join Payments" })).toBeTruthy();
    await actor.click(screen.getByRole("button", { name: /Accept invitation/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspaceId: ids.workspace }));
  });

  it("explains an expired link", async () => {
    server.on("GET /api/invitations/:token", failWith(410, "This invitation has expired"));
    await renderRoute("/invite/old");
    expect(await screen.findByText("This invitation has expired")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Open invitation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Accept invitation/ })).toBeNull();
  });

  it("reports an invitation that can no longer be accepted", async () => {
    server
      .on("GET /api/invitations/:token", { workspaceName: "Payments", role: "member", expiresAt: "x" })
      .on("POST /api/invitations/:token/accept", failWith(409, "Invitation already used"));
    const { user: actor } = await renderRoute("/invite/used");
    await actor.click(await screen.findByRole("button", { name: /Accept invitation/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invitation already used");
  });
});
