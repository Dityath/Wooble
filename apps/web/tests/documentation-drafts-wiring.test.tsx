import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { InspectorPanel } from "../src/features/inspector/inspector-panel";
import { draftKey, readDraft, writeDraft } from "../src/features/inspector/documentation/drafts";
import { useEditorStore } from "../src/stores/editor-store";
import type { CanvasGraph } from "../src/lib/api";
import { editorFromElement, typeInEditor } from "./support/editor";
import { FakeApi, failWith } from "./support/fake-api";
import { FakeSocket, installFakeSocket, restoreWebSocket } from "./support/fake-socket";
import { entity, graph, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery, testQueryClient } from "./support/render";

let server: FakeApi;
beforeEach(() => {
  localStorage.clear();
  installFakeSocket();
  server = new FakeApi().install();
  useEditorStore.setState({ selectedEntityId: null, selectedConnectionId: null, positions: {} });
});
afterEach(() => {
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

describe("revocation", () => {
  it("offers no draft once access flips to viewer", async () => {
    seed();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    const queryClient = testQueryClient();
    const view = await openDetails(queryClient);
    await typeUntilDrafted();
    server.on("GET /api/canvases/:id/access", { role: "viewer" });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["canvas-access", ids.canvas] });
    });
    // The page replaces the editor with the read-only viewer; remounting the panel stands in for that here.
    view.unmount();
    await openDetails(queryClient);
    await settle();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
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
  const node = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (element) => element.querySelector(".architecture-node-name")?.textContent === "Orders API",
  ) as HTMLElement;
  fireEvent.click(node);
  const inspector = document.querySelector(".canvas-workspace .inspector-panel") as HTMLElement;
  await view.user.click(await within(inspector).findByRole("button", { name: /Open details/ }));
  const dialog = await screen.findByRole("dialog", { name: "Canvas details" });
  await view.user.click(within(dialog).getByRole("button", { name: "Documentation" }));
  await within(dialog).findByRole("textbox", { name: "Documentation" });
  return { ...view, dialog };
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

  it("Close closes the dialog and the draft is kept", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    server.on("PATCH /api/entities/:id", failWith(503, "Unavailable"));
    await typeUntilDrafted();
    await actor.click(closeButton(dialog));
    const confirm = await screen.findByRole("alertdialog");
    const confirmClose = within(confirm)
      .getAllByRole("button", { name: "Close" })
      .find((button) => !button.querySelector("svg")) as HTMLElement;
    await actor.click(confirmClose);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Canvas details" })).toBeNull());
    expect(mine(ids.service)).toContain("!");
  });

  it("closes without a prompt when nothing is unsaved", async () => {
    const { user: actor, dialog } = await openCanvasDetails();
    await actor.click(closeButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
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
