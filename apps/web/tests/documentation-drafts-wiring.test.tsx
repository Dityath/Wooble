import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type userEvent from "@testing-library/user-event";
import { InspectorPanel } from "../src/features/inspector/inspector-panel";
import {
  draftKey,
  readDraft,
  resumeDocumentationDrafts,
  writeDraft,
} from "../src/features/inspector/documentation/drafts";
import { useEditorStore } from "../src/stores/editor-store";
import type { CanvasGraph } from "../src/lib/api";
import { editorFromElement, typeInEditor } from "./support/editor";
import { FakeApi, failWith } from "./support/fake-api";
import { FakeSocket, installFakeSocket, restoreWebSocket } from "./support/fake-socket";
import { entity, graph, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery, testQueryClient } from "./support/render";

let server: FakeApi;
beforeEach(() => {
  resumeDocumentationDrafts();
  localStorage.clear();
  installFakeSocket();
  server = new FakeApi().install();
  // Default save target; routes a test registers later take precedence (FakeApi: later registrations win).
  server.on("PATCH /api/entities/:entityId", {});
  useEditorStore.setState({ selectedEntityId: null, selectedConnectionId: null, positions: {} });
});
afterEach(async () => {
  // Unmount and let queued documentation saves finish while the fake fetch is still installed, so none
  // escapes to the real network after the test ends.
  cleanup();
  for (let round = 0; round < 3; round++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  // Sign-out suspends drafts for the whole process; later tests (and files) start with them on.
  resumeDocumentationDrafts();
  server.restore();
  restoreWebSocket();
  localStorage.clear();
});

const draftKeys = () =>
  Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter((key) =>
    key.startsWith("wooble:draft:"),
  );
const documentation = () => screen.getByRole("textbox", { name: "Documentation" });
const caretToEnd = () =>
  act(() => {
    const editor = editorFromElement(documentation());
    editor.commands.setTextSelection(editor.state.doc.content.size);
  });
async function typeText(text: string) {
  await caretToEnd();
  await typeInEditor(documentation(), text);
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
const mine = (id: string) => readDraft(ids.user, "entity", id)?.markdown;
const never = () => new Promise<never>(() => {});

type Me = "ok" | "pending" | "error";
type Role = "editor" | "manager" | "viewer" | "pending" | "error";
function seed(me: Me = "ok", role: Role = "editor") {
  server
    .on("GET /api/auth/me", me === "ok" ? user() : me === "error" ? failWith(401, "Unauthorized") : never)
    .on(
      "GET /api/canvases/:id/access",
      role === "error" ? failWith(500, "Boom") : role === "pending" ? never : { role },
    );
}

function Details({ data }: { data: CanvasGraph }) {
  const id = useEditorStore((state) => state.selectedEntityId);
  return <InspectorPanel key={id} graph={data} canvasId={ids.canvas} mode="details" detailSection="documentation" />;
}
function withDocs() {
  const data = graph();
  data.entities[1] = entity(ids.service, "service", "Orders API", { documentation: "Saved text" });
  data.entities[2] = entity(ids.database, "database", "Orders DB", { documentation: "DB saved" });
  return data;
}
async function openDetails(queryClient: QueryClient = testQueryClient()) {
  useEditorStore.getState().setEntitySelected(ids.service);
  const view = renderWithQuery(<Details data={withDocs()} />, queryClient);
  await screen.findByRole("textbox", { name: "Documentation" });
  return view;
}
/** Types until the draft shows up, which it does once identity and access resolved. */
const typeUntilDrafted = () =>
  waitFor(async () => {
    await typeText("!");
    expect(mine(ids.service)).toBeTruthy();
  });

describe("draft identity and access gate", () => {
  it("writes drafts under the signed-in user once identity and edit access resolved", async () => {
    seed();
    await openDetails();
    await typeUntilDrafted();
    expect(draftKeys()).toEqual([draftKey(ids.user, "entity", ids.service)]);
  });

  it("lets a workspace manager keep drafts, as the API lets managers write documentation", async () => {
    seed("ok", "manager");
    await openDetails();
    await typeUntilDrafted();
  });

  for (const [label, me, role] of [
    ["identity is loading", "pending", "editor"],
    ["identity failed", "error", "editor"],
    ["access is loading", "ok", "pending"],
    ["access failed", "ok", "error"],
    ["access is viewer", "ok", "viewer"],
  ] as const) {
    it(`reads, writes and offers no draft while ${label}`, async () => {
      writeDraft(ids.user, "entity", ids.service, "Earlier draft");
      seed(me, role);
      await openDetails();
      await settle();
      await typeText("!");
      expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
      expect(mine(ids.service)).toBe("Earlier draft");
    });
  }

  it("offers nothing from a cached editor role until the access refetch resolves, then follows the result", async () => {
    seed();
    writeDraft(ids.user, "entity", ids.service, "My unsaved draft");
    let release: (role: { role: string }) => void = () => {};
    server.on("GET /api/canvases/:id/access", () => new Promise((resolve) => (release = resolve)));
    const queryClient = testQueryClient();
    queryClient.setQueryData(["me"], user());
    queryClient.setQueryData(["canvas-access", ids.canvas], { role: "editor" });
    await openDetails(queryClient);
    await settle();
    // The cached editor role is stale until the refetch says otherwise: nothing is read, offered or written.
    expect(server.requests("GET", `/api/canvases/${ids.canvas}/access`)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(mine(ids.service)).toBe("My unsaved draft");

    await act(async () => release({ role: "editor" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("refetches access on mount even when another observer's fresh result is cached, then enables drafts", async () => {
    seed();
    writeDraft(ids.user, "entity", ids.service, "My unsaved draft");
    let release: (role: { role: string }) => void = () => {};
    server.on("GET /api/canvases/:id/access", () => new Promise((resolve) => (release = resolve)));
    const queryClient = testQueryClient();
    queryClient.setQueryData(["me"], user());
    // Another observer (the page shell) fetched this just now, so the default staleTime would reuse it.
    queryClient.setDefaultOptions({ queries: { staleTime: 20_000, retry: false } });
    queryClient.setQueryData(["canvas-access", ids.canvas], { role: "editor" });
    await openDetails(queryClient);
    await settle();
    expect(server.requests("GET", `/api/canvases/${ids.canvas}/access`)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    await act(async () => release({ role: "editor" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("never offers a draft when the refetch behind a cached editor role says viewer", async () => {
    seed();
    writeDraft(ids.user, "entity", ids.service, "My unsaved draft");
    let release: (role: { role: string }) => void = () => {};
    server.on("GET /api/canvases/:id/access", () => new Promise((resolve) => (release = resolve)));
    const queryClient = testQueryClient();
    queryClient.setQueryData(["me"], user());
    queryClient.setQueryData(["canvas-access", ids.canvas], { role: "editor" });
    await openDetails(queryClient);
    await settle();
    await act(async () => release({ role: "viewer" }));
    await settle();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(mine(ids.service)).toBe("My unsaved draft");
  });

  it("never offers another user's draft for the same object id", async () => {
    seed();
    writeDraft(ids.otherUser, "entity", ids.service, "Grace's draft");
    await openDetails();
    await settle();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("offers the signed-in user's own draft", async () => {
    seed();
    writeDraft(ids.user, "entity", ids.service, "My unsaved draft");
    await openDetails();
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
  });
});

describe("selection change with unsaved documentation", () => {
  it("keeps a failed save as a draft offered on that object only", async () => {
    seed();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await openDetails();
    await typeUntilDrafted();
    await act(async () => useEditorStore.getState().setEntitySelected(ids.database));
    await screen.findByText("DB saved");
    await waitFor(() => expect(server.requests("PATCH", `/api/entities/${ids.service}`).length).toBeGreaterThan(0));
    await settle();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(mine(ids.database)).toBeUndefined();
    expect(mine(ids.service)).toContain("!");

    await act(async () => useEditorStore.getState().setEntitySelected(ids.service));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("saves the unsaved text of the first object when its panel unmounts", async () => {
    seed();
    server.on("PATCH /api/entities/:id", {});
    await openDetails();
    await typeUntilDrafted();
    await act(async () => useEditorStore.getState().setEntitySelected(ids.database));
    await waitFor(() => expect(server.requests("PATCH", `/api/entities/${ids.service}`)).toHaveLength(1));
    expect(server.requests("PATCH", `/api/entities/${ids.service}`)[0].body).toMatchObject({
      metadata: { documentation: expect.stringContaining("!") },
    });
    await waitFor(() => expect(mine(ids.service)).toBeUndefined());
  });
});

function seedCanvas() {
  server
    .on("GET /api/auth/me", user())
    .on("GET /api/workspaces", [workspace()])
    .on("GET /api/canvases/:id/graph", withDocs())
    .on("GET /api/canvases/:id/access", { role: "editor" })
    .on("GET /api/canvases/:id/activity", { events: [] });
}
async function openCanvasDetails() {
  seedCanvas();
  const view = await renderRoute(`/canvases/${ids.canvas}`);
  await screen.findByText("Orders API", {}, { timeout: 3000 });
  return { ...view, ...(await openNodeDocumentation(view.user)) };
}
async function openNodeDocumentation(actor: ReturnType<typeof userEvent.setup>) {
  const node = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (element) => element.querySelector(".architecture-node-name")?.textContent === "Orders API",
  ) as HTMLElement;
  fireEvent.click(node);
  const inspector = document.querySelector(".canvas-workspace .inspector-panel") as HTMLElement;
  await actor.click(await within(inspector).findByRole("button", { name: /Open details/ }));
  const dialog = await screen.findByRole("dialog", { name: "Canvas details" });
  await actor.click(within(dialog).getByRole("button", { name: "Documentation" }));
  await within(dialog).findByRole("textbox", { name: "Documentation" });
  return { dialog };
}
const closeButton = (dialog: HTMLElement) =>
  within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement;

describe("closing the details dialog", () => {
  it("asks before closing with unsaved documentation, and Keep editing keeps the dialog and the text", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    await actor.click(closeButton(dialog));
    const confirm = await screen.findByRole("alertdialog", { name: "Close with unsaved documentation?" });
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep editing" }));
    await actor.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Canvas details" })).toBeTruthy();
    expect(documentation().textContent).toContain("!");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("asks again on Escape while documentation is unsaved", async () => {
    const { dialog } = await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    await act(async () => documentation().blur());
    fireEvent.keyDown(dialog, { key: "Escape" });
    await screen.findByRole("alertdialog", { name: "Close with unsaved documentation?" });
  });

  it("Close anyway closes everything, keeps the draft and leaves focus to the element that opened the dialog", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    await actor.click(closeButton(dialog));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByRole("button", { name: "Keep editing" })).toBeTruthy();
    expect(confirm.textContent).toContain("kept on this device");
    await actor.click(within(confirm).getByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Canvas details" })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mine(ids.service)).toContain("!");
    // Not pulled back into the (closed) editor.
    expect(Boolean(document.activeElement?.closest("[contenteditable='true']"))).toBe(false);
    expect(document.activeElement?.textContent?.includes("Open details")).toBe(true);
  });

  it("does not ask again on the next keystroke when a save finished while the confirm was open", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    let finishSave: () => void = () => {};
    server.on("PATCH /api/entities/:id", () => new Promise((resolve) => (finishSave = () => resolve({}))));
    await typeText("!");
    await act(async () => documentation().blur());
    await waitFor(() => expect(server.requests("PATCH", `/api/entities/${ids.service}`)).toHaveLength(1));
    await actor.click(closeButton(dialog));
    await screen.findByRole("alertdialog", { name: "Close with unsaved documentation?" });

    await act(async () => finishSave());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Canvas details" })).toBeTruthy();

    await typeText("?");
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes without a prompt when nothing is unsaved", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    await actor.click(closeButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("replaces a mounted editor when access is revoked, and may offer the user's own last text once access returns", async () => {
    const { queryClient, user: actor } = await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    const lastText = mine(ids.service);

    server.on("GET /api/canvases/:id/access", { role: "viewer" });
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: ["canvas-access", ids.canvas] });
    });
    await settle();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Documentation" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();

    // Intended behaviour: nothing offers a draft to a viewer, but the text stays on this device for the same user. If
    // write access comes back, that user's own last text is offered again; it is never shown to anyone else.
    server.on("GET /api/canvases/:id/access", { role: "editor" });
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: ["canvas-access", ids.canvas] });
    });
    await settle();
    // The page swapped to the read-only view and back, so the details are opened again.
    if (!screen.queryByRole("textbox", { name: "Documentation" })) await openNodeDocumentation(actor);
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    expect(mine(ids.service)).toBe(lastText);
  });

  it("replaces the editor and offers no draft after a live 1008 flips access to viewer", async () => {
    await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    server.on("GET /api/canvases/:id/access", { role: "viewer" });
    FakeSocket.latest().open();
    FakeSocket.latest().drop(1008);
    await waitFor(() => expect(server.requests("GET", `/api/canvases/${ids.canvas}/access`).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Documentation" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});

describe("purging drafts on sign-out and password change", () => {
  async function withFailingEditorMounted() {
    const view = await openCanvasDetails();
    // The session is gone, so the save fails with 401.
    server.on("PATCH /api/entities/:id", failWith(401, "Unauthorized"));
    await typeUntilDrafted();
    return view;
  }
  const signOut = () => {
    // A modal dialog is open, so the account menu is reached through the DOM rather than the accessibility tree.
    fireEvent.click(document.querySelector("[aria-label='Open account menu']") as HTMLElement);
    fireEvent.click(document.querySelector(".account-menu-signout") as HTMLElement);
  };

  it("removes every draft after sign-out, even with an editor whose save fails", async () => {
    server.on("POST /api/auth/logout", { ok: true });
    const view = await withFailingEditorMounted();
    writeDraft(ids.otherUser, "connection", ids.connection, "Someone else");
    signOut();
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/login"));
    await settle();
    expect(draftKeys()).toEqual([]);
  });

  it("keeps drafts when sign-out fails", async () => {
    server.on("POST /api/auth/logout", failWith(503, "Service unavailable"));
    await withFailingEditorMounted();
    signOut();
    await waitFor(() => expect(document.querySelector(".account-menu-error")).toBeTruthy());
    expect(draftKeys()).toEqual([draftKey(ids.user, "entity", ids.service)]);
  });

  async function changePassword() {
    server.on("GET /api/auth/me", user()).on("GET /api/workspaces", [workspace()]).on("GET /api/canvases", []);
    writeDraft(ids.user, "entity", ids.service, "Unsaved");
    const view = await renderRoute("/profile");
    await view.user.click(await screen.findByRole("button", { name: /Change password/ }));
    await view.user.type(screen.getByLabelText("Current password"), "old-password");
    await view.user.type(screen.getByLabelText("New password"), "new-password-long");
    await view.user.click(screen.getAllByRole("button", { name: "Change password" }).at(-1) as HTMLElement);
    return view;
  }

  it("removes every draft after a password change", async () => {
    server.on("PUT /api/auth/password", { ok: true });
    const { router } = await changePassword();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(draftKeys()).toEqual([]);
  });

  it("keeps drafts when the password change fails", async () => {
    server.on("PUT /api/auth/password", failWith(400, "Wrong password"));
    await changePassword();
    await screen.findByText("Wrong password");
    expect(draftKeys()).toHaveLength(1);
  });
});
