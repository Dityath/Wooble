import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { ArchitectureConnection, ConnectionPath } from "@wooble/domain";
import type { CanvasGraph } from "../src/lib/api";
import { useEditorStore } from "../src/stores/editor-store";
// The canvas viewer imports the read-only renderer through the inspector barrel, the entity page imports the
// module itself. Both must be the same component after the editor branch moved the file.
import { MarkdownContent as markdownContentFromInspector } from "../src/features/inspector/rich-documentation";
import { MarkdownContent as markdownContentFromDocumentation } from "../src/features/inspector/documentation/markdown-content";
import { FakeApi, failWith } from "./support/fake-api";
import { FakeSocket, installFakeSocket, restoreWebSocket } from "./support/fake-socket";
import { graph, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery } from "./support/render";

let server: FakeApi;

beforeEach(() => {
  installFakeSocket();
  useEditorStore.setState({ selectedEntityId: null, selectedConnectionId: null, positions: {} });
  server = new FakeApi()
    .install()
    .on("GET /api/auth/me", user())
    .on("GET /api/workspaces", [workspace()])
    .on("GET /api/canvases/:id/graph", graph())
    .on("GET /api/canvases/:id/access", { role: "editor" })
    .on("GET /api/canvases/:id/activity", { events: [] });
});
afterEach(() => {
  server.restore();
  restoreWebSocket();
});

const node = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (element) => element.querySelector(".architecture-node-name, .system-boundary-title")?.textContent === name,
  ) as HTMLElement;
const pane = () => document.querySelector(".react-flow__pane") as HTMLElement;

async function openCanvas(role: "editor" | "viewer" | "manager" = "editor", data: CanvasGraph = graph()) {
  server.on("GET /api/canvases/:id/access", { role }).on("GET /api/canvases/:id/graph", data);
  const view = await renderRoute(`/canvases/${ids.canvas}`);
  await screen.findByText("Orders API", {}, { timeout: 3000 });
  await viewportSettled();
  return view;
}

/**
 * Waits for the animated initial fitView (scheduled a frame after mount, 180ms long) to finish so
 * screen-to-canvas coordinates stay fixed: the transform must hold across readings spanning 300ms.
 */
async function viewportSettled() {
  const transform = () => (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform;
  let previous = transform();
  let stableSince = Date.now();
  await waitFor(
    () => {
      const current = transform();
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince < 300) throw new Error("The viewport may still be animating");
    },
    { interval: 50, timeout: 4000 },
  );
}

describe("canvas loading", () => {
  it("shows a spinner, then the diagram, systems, and live presence", async () => {
    let release: () => void = () => {};
    server.on("GET /api/canvases/:id/graph", () => new Promise((resolve) => (release = () => resolve(graph()))));
    await renderRoute(`/canvases/${ids.canvas}`);
    expect(await screen.findByText("Opening architecture canvas…")).toBeTruthy();
    release();

    await screen.findByText("Orders API");
    expect(screen.getByText("Storefront", { selector: ".system-boundary-title" })).toBeTruthy();
    expect(screen.getByText("1 components")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reads orders" })).toBeTruthy();
    expect(screen.getByText("Checkout flow", { selector: "strong" })).toBeTruthy();
    const systems = screen.getByRole("navigation", { name: "System hierarchy" });
    expect(within(systems).getByText("Storefront")).toBeTruthy();

    const presence = screen.getByRole("region", { name: "People on this canvas" });
    expect(within(presence).getByText("Connecting to live canvas…")).toBeTruthy();
    FakeSocket.latest().open();
    expect(within(presence).getByText("On this canvas · 1")).toBeTruthy();
    expect(within(presence).getByText("Only you are here")).toBeTruthy();
    expect(within(presence).getByText("Ada Lovelace (you)")).toBeTruthy();
  });

  it("explains load failures and retries", async () => {
    server.on("GET /api/canvases/:id/access", failWith(403, "You do not have access to this canvas"));
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}`);
    expect(await screen.findByRole("heading", { name: "This canvas could not be opened" })).toBeTruthy();
    expect(screen.getByText("You do not have access to this canvas")).toBeTruthy();
    server.on("GET /api/canvases/:id/access", { role: "editor" });
    await actor.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Orders API")).toBeTruthy();
  });
});

/**
 * Long documentation of the shape a reader actually meets on a shared connection: prose, a fenced code block and a
 * GFM table. The read-only renderer must show all of it without turning any of it into an editable control.
 */
const richDocumentation = [
  "# Order intake",
  "",
  "The reader retries **twice**, then dead-letters the message.",
  "",
  "```json",
  '{ "retries": 2, "timeoutMs": 500 }',
  "```",
  "",
  "| Endpoint | Purpose |",
  "| --- | --- |",
  "| GET /orders | List orders |",
  "| POST /orders | Create an order |",
].join("\n");

/** Asserts the read-only promise of a viewer or guest journey: it reads and never writes. */
function expectReadOnlyRequests() {
  expect(server.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([]);
  expect(server.requests("PATCH", /^\/api\/(entities|connections|canvases)\//)).toHaveLength(0);
  expect(server.requests("POST", /^\/api\//)).toHaveLength(0);
  expect(server.requests("DELETE", /^\/api\//)).toHaveLength(0);
}

/** Asserts the documentation region is a reader surface: rendered markdown, no editing control at all. */
function expectReadOnlyDocumentation(documentation: HTMLElement) {
  expect(within(documentation).queryByRole("textbox")).toBeNull();
  expect(within(documentation).queryAllByRole("button")).toEqual([]);
  expect(documentation.querySelector("[contenteditable]")).toBeNull();
  expect(documentation.querySelector("textarea")).toBeNull();
  expect(documentation.querySelector("input")).toBeNull();
}

/** Clicks the connection edge the way a reader does: focus it from the edge label, then select the line. */
async function selectConnection(actor: ReturnType<typeof userEvent.setup>) {
  await actor.click(screen.getByRole("button", { name: "Reads orders" }));
  fireEvent.click(document.querySelector(".react-flow__edge") as Element);
}

describe("viewer canvas", () => {
  it("opens read-only details for nodes and connections", async () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { contractBody: "SELECT * FROM orders" } };
    const { user: actor, router } = await openCanvas("viewer", data);
    expect(screen.getByText("Viewer access · Select a node to open details")).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).toBeNull();

    fireEvent.click(node("Orders API"));
    const details = await screen.findByRole("complementary", { name: "Selected item details" });
    expect(within(details).getByRole("heading", { name: "Orders API" })).toBeTruthy();
    expect(within(details).getByText("No description yet.")).toBeTruthy();

    await actor.click(screen.getByRole("button", { name: "Reads orders" }));
    fireEvent.click(document.querySelector(".react-flow__edge") as Element);
    await waitFor(() => expect(within(details).getByText("SELECT * FROM orders")).toBeTruthy());
    await actor.click(within(details).getByRole("button", { name: "Close selection" }));
    expect(screen.queryByRole("complementary", { name: "Selected item details" })).toBeNull();

    fireEvent.click(node("Orders DB"));
    await actor.click(await screen.findByRole("button", { name: "Open details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/entities/${ids.database}`));
    expect(router.state.location.search).toEqual({ canvasId: ids.canvas });
  });

  it("shows connection documentation read-only, with an empty state", async () => {
    const data = graph();
    data.connections[0] = {
      ...data.connections[0],
      metadata: { documentation: "## Retry policy\n\nRetries **twice** before failing." },
    };
    const { user: actor } = await openCanvas("viewer", data);
    await actor.click(screen.getByRole("button", { name: "Reads orders" }));
    fireEvent.click(document.querySelector(".react-flow__edge") as Element);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });
    expect(within(documentation).getByRole("heading", { name: "Retry policy" })).toBeTruthy();
    expect(within(documentation).getByText("twice", { selector: "strong" })).toBeTruthy();
    expect(within(documentation).queryByRole("textbox")).toBeNull();
    expect(within(documentation).queryByRole("button")).toBeNull();
  });

  it("says when a connection has no documentation yet", async () => {
    const { user: actor } = await openCanvas("viewer");
    await selectConnection(actor);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });
    expect(within(documentation).getByText("No documentation yet.")).toBeTruthy();
  });

  it("renders long documentation with a code block and a table, using the entity page's read-only renderer", async () => {
    // The editor branch moved MarkdownContent into documentation/markdown-content.tsx and kept a re-export at
    // rich-documentation.tsx. The viewer must still get the same renderer the entity page imports.
    expect(markdownContentFromInspector).toBe(markdownContentFromDocumentation);

    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { documentation: richDocumentation } };
    const { user: actor } = await openCanvas("viewer", data);
    await selectConnection(actor);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });

    expect(within(documentation).getByRole("heading", { name: "Order intake" })).toBeTruthy();
    expect(within(documentation).getByText("twice", { selector: "strong" })).toBeTruthy();
    expect(documentation.querySelector("pre code")?.textContent).toContain('"retries": 2');
    const table = within(documentation).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Endpoint" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "POST /orders" })).toBeTruthy();
    expectReadOnlyDocumentation(documentation);

    // Rendered output is identical to the module the entity page imports, so both readers see the same markdown.
    const direct = renderWithQuery(markdownContentFromDocumentation({ value: richDocumentation }));
    expect(documentation.querySelector("article")?.outerHTML).toBe(direct.container.innerHTML);
    direct.unmount();
  });

  it("sends no write request while a viewer reads connection documentation", async () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { documentation: richDocumentation } };
    // Any write attempt would be recorded here, so the assertions below are evidence, not decoration.
    server.on("PATCH /api/connections/:id", failWith(403, "Viewers cannot edit connections"));
    const { user: actor } = await openCanvas("viewer", data);
    await selectConnection(actor);
    await screen.findByRole("region", { name: "Connection documentation" });
    await actor.click(screen.getByRole("button", { name: "Zen mode" }));
    await actor.click(screen.getByRole("button", { name: "Exit Zen mode" }));
    expectReadOnlyRequests();
  });

  it("never fetches or renders another canvas's connection while viewing an authorized one", async () => {
    const bend: ConnectionPath = null;
    const shared: ArchitectureConnection & { bend: ConnectionPath } = {
      ...graph().connections[0],
      metadata: { documentation: "Shared documentation." },
    };
    // A second canvas, served under its own routes and open to anyone who asks: only the page must refrain from asking.
    const offCanvas: ArchitectureConnection & { bend: ConnectionPath } = {
      id: ids.secondConnection,
      workspaceId: ids.workspace,
      sourceEntityId: ids.service,
      targetEntityId: ids.database,
      type: "rest",
      label: "Writes orders",
      description: null,
      metadata: { documentation: "Off-canvas documentation." },
      bend,
    };
    const otherGraph = graph({ canvas: { ...graph().canvas, id: ids.otherCanvas }, connections: [offCanvas] });
    const data = { ...graph(), connections: [shared] };
    server
      .on("GET /api/canvases/:id/access", { role: "viewer" })
      .on("GET /api/connections/:id", ({ params }) => (params.id === offCanvas.id ? offCanvas : shared));
    const { user: actor } = await openCanvas("viewer", data);
    // openCanvas registers the shared graph for every canvas id; serve the other canvas under its own id again.
    server.on("GET /api/canvases/:id/graph", ({ params }) => (params.id === ids.otherCanvas ? otherGraph : data));
    await selectConnection(actor);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });
    expect(within(documentation).getByText("Shared documentation.")).toBeTruthy();

    const edges = [...document.querySelectorAll(".react-flow__edge")];
    expect(edges).toHaveLength(1);
    expect(edges[0].getAttribute("data-id")).toBe(shared.id);
    expect(document.body.textContent).not.toContain("Writes orders");
    expect(document.body.textContent).not.toContain("Off-canvas documentation.");
    expect(server.requests("GET", `/api/canvases/${ids.otherCanvas}/graph`)).toHaveLength(0);
    expect(server.requests("GET", `/api/canvases/${ids.otherCanvas}/access`)).toHaveLength(0);
    expect(server.requests("GET", `/api/connections/${offCanvas.id}`)).toHaveLength(0);
    expect(server.requests("GET", `/api/connections/${shared.id}`)).toHaveLength(0);
    expectReadOnlyRequests();
  });

  it("clears the selection from the pane and toggles Zen mode", async () => {
    const { user: actor } = await openCanvas("viewer");
    fireEvent.click(node("Orders API"));
    await screen.findByRole("complementary", { name: "Selected item details" });
    fireEvent.click(pane());
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Selected item details" })).toBeNull());

    await actor.click(screen.getByRole("button", { name: /Zen mode/ }));
    expect(screen.getByRole("button", { name: /Exit Zen mode/ }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".app-shell")?.className).toContain("canvas-zen-mode");
    await actor.click(screen.getByRole("button", { name: /Exit Zen mode/ }));
    expect(document.querySelector(".app-shell")?.className).not.toContain("canvas-zen-mode");
  });

  it("tells viewers when a shared canvas is empty", async () => {
    const empty = { ...graph(), placements: [], connections: [] };
    server.on("GET /api/canvases/:id/access", { role: "viewer" }).on("GET /api/canvases/:id/graph", empty);
    await renderRoute(`/canvases/${ids.canvas}`);
    expect(await screen.findByText("This shared canvas has no nodes yet.")).toBeTruthy();
  });
});

/** Converts a canvas (flow) coordinate into a client coordinate using the rendered viewport transform. */
function flowToClient(point: { x: number; y: number }) {
  const transform = (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  const [, tx, ty, zoom] = transform.match(/translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\(([\d.]+)\)/) ?? [];
  return { clientX: point.x * Number(zoom) + Number(tx), clientY: point.y * Number(zoom) + Number(ty) };
}
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ctrlKey: true, ...init });
const tool = (name: string) => screen.getByRole("button", { name });
const inspector = () => document.querySelector(".canvas-workspace .inspector-panel") as HTMLElement | null;

describe("editing tools", () => {
  it("selects nodes into the inspector and switches tools from the toolbox and keyboard", async () => {
    const { user: actor } = await openCanvas();
    fireEvent.click(node("Orders API"));
    await waitFor(() =>
      expect(within(inspector() as HTMLElement).getByRole("heading", { name: "Orders API" })).toBeTruthy(),
    );
    expect(FakeSocket.latest().sent).toEqual([]);

    await actor.click(tool("Add node"));
    expect(tool("Add node").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Click the canvas to place a node")).toBeTruthy();
    press("b");
    expect(screen.getByText("Click the canvas to place a system box")).toBeTruthy();
    press("c");
    expect(screen.getByText("Click the source node")).toBeTruthy();
    press("e");
    expect(screen.getByText("Click a connector, then double-click its line to add a point")).toBeTruthy();
    press("s");
    expect(tool("Select").getAttribute("aria-pressed")).toBe("true");
    press("h");
    expect(tool("Hand").getAttribute("aria-pressed")).toBe("true");
    expect(inspector()).toBeNull();

    fireEvent.click(node("Orders API"));
    expect(inspector()).toBeNull();
    await actor.click(tool("Select"));
    await actor.click(tool("Add node"));
    await actor.click(tool("Connector"));
    await actor.click(tool("System box"));
    await actor.click(tool("Edit connector"));
    await actor.click(tool("Hand"));
    expect(tool("Hand").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores shortcuts while typing and shows tool hints in tooltips", async () => {
    const { user: actor } = await openCanvas();
    const search = document.createElement("input");
    document.body.append(search);
    fireEvent.keyDown(search, { key: "n", ctrlKey: true });
    expect(tool("Select").getAttribute("aria-pressed")).toBe("true");
    search.remove();

    await actor.hover(tool("Add node"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Ctrl+N");
  });

  it("places a node inside the system under the pointer", async () => {
    server.on("POST /api/canvases/:id/entities", { id: ids.gateway });
    await openCanvas();
    press("n");
    fireEvent.click(pane(), flowToClient({ x: 100, y: 250 }));
    await waitFor(() => expect(server.requests("POST", `/api/canvases/${ids.canvas}/entities`)).toHaveLength(1));
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      type: "service",
      name: "",
      x: 100,
      y: 250,
      parentEntityId: ids.system,
    });
    await waitFor(() => expect(useEditorStore.getState().selectedEntityId).toBe(ids.gateway));
    expect(tool("Select").getAttribute("aria-pressed")).toBe("true");
  });

  it("places a system box on open canvas and reports creation errors", async () => {
    server.on("POST /api/canvases/:id/entities", failWith(403, "Viewers cannot add nodes"));
    await openCanvas();
    press("b");
    fireEvent.click(pane(), flowToClient({ x: 1500, y: 900 }));
    expect((await screen.findByRole("alert")).textContent).toBe("Viewers cannot add nodes");
    expect(server.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      type: "system",
      x: 1500,
      y: 900,
      parentEntityId: null,
    });
  });

  it("adds a node by clicking inside a system box", async () => {
    server.on("POST /api/canvases/:id/entities", { id: ids.gateway });
    await openCanvas();
    press("n");
    fireEvent.click(node("Storefront"), flowToClient({ x: 300, y: 20 }));
    await waitFor(() => expect(server.requests("POST", `/api/canvases/${ids.canvas}/entities`)).toHaveLength(1));
    expect(server.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      x: 300,
      y: 20,
      parentEntityId: ids.system,
    });
  });

  it("connects two nodes with the connector tool", async () => {
    server.on("POST /api/canvases/:id/connections", { id: ids.secondConnection });
    await openCanvas();
    press("c");
    fireEvent.click(node("Orders DB"));
    expect(screen.getByText("Click the target node")).toBeTruthy();
    fireEvent.click(node("Orders DB"));
    fireEvent.click(node("Orders API"));
    await waitFor(() => expect(useEditorStore.getState().selectedConnectionId).toBe(ids.secondConnection));
    expect(server.requests("POST", `/api/canvases/${ids.canvas}/connections`).map((call) => call.body)).toEqual([
      { sourceEntityId: ids.database, targetEntityId: ids.service, type: "rest" },
    ]);
  });

  it("keeps the connector tool active when a connection is rejected", async () => {
    server.on("POST /api/canvases/:id/connections", failWith(400, "Choose two different nodes"));
    await openCanvas();
    press("c");
    fireEvent.click(node("Orders DB"));
    fireEvent.click(node("Orders API"));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose two different nodes");
    expect(tool("Connector").getAttribute("aria-pressed")).toBe("true");
  });

  it("clears the selection when the pane is clicked", async () => {
    await openCanvas();
    fireEvent.click(node("Orders API"));
    await waitFor(() => expect(inspector()).toBeTruthy());
    fireEvent.click(pane());
    await waitFor(() => expect(inspector()).toBeNull());
  });
});

describe("connector routes", () => {
  it("adds, drags, removes, and resets connector points", async () => {
    server.on("PUT /api/canvases/:id/connections/:connectionId/bend", ({ body }) => body);
    const bent = graph();
    bent.connections[0] = { ...bent.connections[0], bend: [{ x: 500, y: 150 }] };
    await openCanvas("editor", bent);
    press("e");
    fireEvent.click(document.querySelector(".react-flow__edge") as Element);
    expect(await screen.findByText(/Double-click a line to add a point/)).toBeTruthy();

    const bends = () => server.requests("PUT", `/api/canvases/${ids.canvas}/connections/${ids.connection}/bend`);
    const pointAt = (index: number) => (bends()[index].body as { bend: Array<{ x: number; y: number }> }).bend;
    const hitbox = screen.getByRole("button", { name: "Add connector point" });
    fireEvent.doubleClick(hitbox, flowToClient({ x: 700, y: 150 }));
    await waitFor(() => expect(bends()).toHaveLength(1));
    expect(pointAt(0)).toHaveLength(2);
    // Each add builds on the route the one before it produced, even before the previous save comes back.
    fireEvent.keyDown(hitbox, { key: "Enter" });
    fireEvent.keyDown(hitbox, { key: "x" });
    await waitFor(() => expect(bends()).toHaveLength(2));
    expect(pointAt(1)).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /Connector point/ })).toHaveLength(3);

    const handle = await screen.findByRole("button", { name: /Connector point 1;/ });
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, ...flowToClient({ x: 520, y: 180 }) });
    fireEvent.pointerUp(handle, { pointerId: 1, ...flowToClient({ x: 540, y: 200 }) });
    await waitFor(() => expect(bends()).toHaveLength(3));
    // Only the dragged point moved; the other two kept their places.
    expect(pointAt(2)[0]).toEqual({ x: 540, y: 200 });
    expect(pointAt(2)).toHaveLength(3);

    // A cancelled drag is dropped, and a key that is neither Delete nor Backspace changes nothing.
    fireEvent.pointerDown(handle, { pointerId: 2 });
    fireEvent.pointerCancel(handle);
    fireEvent.pointerUp(handle);
    fireEvent.keyDown(handle, { key: "a" });
    expect(bends()).toHaveLength(3);

    fireEvent.keyDown(handle, { key: "Delete" });
    await waitFor(() => expect(bends()).toHaveLength(4));
    expect(pointAt(3)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Connector point/ })).toHaveLength(2);

    // Removing every remaining point is the same as having no stored bend at all. Each press takes the last handle,
    // so removing one never renames the handles still on screen.
    for (let remaining = 1; remaining >= 0; remaining -= 1) {
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: /Connector point/ })).toHaveLength(remaining + 1),
      );
      const last = screen.getAllByRole("button", { name: /Connector point/ }).at(-1);
      if (!last) throw new Error("Missing connector point");
      fireEvent.keyDown(last, { key: "Delete" });
    }
    await waitFor(() => expect(bends()).toHaveLength(6));
    expect(bends()[5].body).toEqual({ bend: null });
    expect(screen.queryAllByRole("button", { name: /Connector point/ })).toHaveLength(0);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Add connector point" }));
    await waitFor(() => expect(bends()).toHaveLength(7));

    fireEvent.click(screen.getByRole("button", { name: "Reset path" }));
    await waitFor(() => expect(bends()).toHaveLength(8));
    expect(bends()[7].body).toEqual({ bend: null });
  });

  it("reports connector path save errors and ignores edits outside the edit tool", async () => {
    server.on("PUT /api/canvases/:id/connections/:connectionId/bend", failWith(409, "Route changed"));
    await openCanvas();
    const hitbox = screen.getByRole("button", { name: "Add connector point" });
    fireEvent.doubleClick(hitbox);
    fireEvent.keyDown(hitbox, { key: "Enter" });
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reads orders" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reads orders" }));
    press("e");
    fireEvent.doubleClick(hitbox, flowToClient({ x: 600, y: 100 }));
    expect((await screen.findByRole("alert")).textContent).toBe("Route changed");
  });

  // Regression: a graph refresh used to rebuild the flow nodes without the box React Flow had measured, which makes
  // each connector report "unmeasured" and remount. The bend handle under the pointer and under keyboard focus went
  // with it, so the next Delete fell through to the canvas shortcut and asked to delete the whole connector.
  it("keeps a connector point mounted and focused when an unrelated graph refresh lands", async () => {
    let saved: ConnectionPath = null;
    server.on("PUT /api/canvases/:id/connections/:connectionId/bend", ({ body }) => {
      saved = (body as { bend: ConnectionPath }).bend;
      return { bend: saved };
    });
    server.on("POST /api/canvases/:id/undo", { undone: true, skipped: [] });
    await openCanvas();
    // A real server keeps the saved path, so any later refresh reads it back unchanged.
    server.on("GET /api/canvases/:id/graph", () => ({
      ...graph(),
      connections: graph().connections.map((item) => ({ ...item, bend: saved })),
    }));
    await screen.findByRole("button", { name: "Reads orders" });
    fireEvent.click(screen.getByRole("button", { name: "Reads orders" }));
    press("e");
    await screen.findByText(/Drag points to reroute/);

    const point = () => screen.queryByRole("button", { name: /Connector point 1;/ });
    const graphReads = () => server.requests("GET", `/api/canvases/${ids.canvas}/graph`).length;
    const hitbox = screen.getByRole("button", { name: "Add connector point" });
    fireEvent.keyDown(hitbox, { key: "Enter" });
    const first = await screen.findByRole("button", { name: /Connector point 1;/ });
    first.focus();
    expect(document.activeElement).toBe(first);
    await waitFor(() => expect(server.requests("PUT", /connections/)).toHaveLength(1));

    // An undo pulls a fresh graph that is identical here: the connector must not be torn down for it.
    const before = graphReads();
    press("z");
    await waitFor(() => expect(server.requests("POST", /undo/)).toHaveLength(1));
    await waitFor(() => expect(graphReads()).toBeGreaterThan(before));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    expect(screen.getByRole("button", { name: "Add connector point" })).toBe(hitbox);
    expect(point()).toBe(first);
    expect(document.activeElement).toBe(first);

    // The keyboard still aims at a point, so this removes that point and nothing else.
    fireEvent.keyDown(first, { key: "Delete" });
    await waitFor(() => expect(point()).toBeNull());
    expect(screen.getByRole("button", { name: "Reads orders" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Loading the canvas, saving a path and undoing it is more waiting than a unit test should assume on a loaded
    // machine, so this journey runs with room to breathe instead of racing the default timeout.
  }, 20_000);
});

describe("undo and Auto Neat", () => {
  it("undoes the last change and explains skipped collaborator changes", async () => {
    server.on("POST /api/canvases/:id/undo", {
      undone: true,
      action: "entity.updated",
      skipped: [
        { action: "entity.updated", targetName: "Orders API", reason: "conflict" },
        { action: "connection.deleted", targetName: null },
        { action: "mystery.action", targetName: "X" },
        { action: "placement.updated", targetName: "Orders DB", reason: "no-op" },
        { action: "canvas.auto_neat", targetName: null, reason: "no-op" },
      ],
    });
    await openCanvas();
    press("z");
    expect((await screen.findByRole("status")).textContent).toContain(
      'Skipped 3 changes a collaborator changed first: Edited "Orders API", Removed connector, mystery.action "X". 2 earlier changes no longer had any visible effect.',
    );
    press("z", { shiftKey: true });
    expect(server.requests("POST", `/api/canvases/${ids.canvas}/undo`)).toHaveLength(1);
  });

  it("describes single skipped changes and quiet no-op undos", async () => {
    let result: unknown = {
      undone: true,
      skipped: [{ action: "entity.created", targetName: "Cache", reason: "conflict" }],
    };
    server.on("POST /api/canvases/:id/undo", () => result);
    await openCanvas();
    press("z");
    expect((await screen.findByRole("status")).textContent).toContain(
      'Skipped 1 change a collaborator changed first: Created "Cache".',
    );
    result = { undone: true, skipped: [{ action: "entity.created", targetName: null, reason: "no-op" }] };
    press("z");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("1 earlier change no longer had any visible effect."),
    );
    result = { undone: false };
    press("z");
    await waitFor(() => expect(server.requests("POST", `/api/canvases/${ids.canvas}/undo`)).toHaveLength(3));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows API and connection errors from undo", async () => {
    server.on("POST /api/canvases/:id/undo", failWith(409, "Nothing to undo"));
    await openCanvas();
    press("z");
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing to undo");
    server.on("POST /api/canvases/:id/undo", () => {
      throw new TypeError("Failed to fetch");
    });
    press("z");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Could not undo the last change. Check your connection."),
    );
  });

  it("tidies the layout with Auto Neat", async () => {
    server.on("PUT /api/canvases/:id/auto-neat", { kind: "saved", updatedAt: "2026-09-02T00:00:00.000Z" });
    const { user: actor } = await openCanvas();
    await actor.click(tool("Auto Neat"));
    await waitFor(() => expect(server.requests("PUT", `/api/canvases/${ids.canvas}/auto-neat`)).toHaveLength(1));
    const body = server.requests("PUT", `/api/canvases/${ids.canvas}/auto-neat`)[0].body as {
      expectedUpdatedAt: string;
      placements: unknown[];
    };
    expect(body.expectedUpdatedAt).toBe(graph().canvas.updatedAt);
    expect(body.placements).toHaveLength(3);
    await waitFor(() => expect(screen.queryByText("Tidying canvas…")).toBeNull());
  });

  it("shows Auto Neat progress and failures", async () => {
    let fail: (value: unknown) => void = () => {};
    server.on("PUT /api/canvases/:id/auto-neat", () => new Promise((resolve) => (fail = resolve)));
    const { user: actor } = await openCanvas();
    await actor.click(tool("Auto Neat"));
    expect(await screen.findByText("Tidying canvas…")).toBeTruthy();
    expect((tool("Select") as HTMLButtonElement).disabled).toBe(true);
    press("n");
    press("z");
    fireEvent.keyDown(window, { key: "Delete" });
    expect(server.requests("POST", `/api/canvases/${ids.canvas}/undo`)).toEqual([]);
    fail(failWith(409, "The canvas changed. Try again."));
    expect(await screen.findByText("The canvas changed. Try again.")).toBeTruthy();
  });
});

describe("moving and resizing", () => {
  /**
   * Drags like a pointer. Node drags start on the first move past React Flow's 1px threshold and measure
   * movement from there, so the pointer nudges 2px first. Resize handles measure from the press instead.
   */
  const drag = (
    element: Element,
    from: { x: number; y: number },
    to: { x: number; y: number },
    { measuredFromPress = false } = {},
  ) => {
    const start = flowToClient(from);
    const end = flowToClient(to);
    const offset = measuredFromPress ? 0 : 2;
    const nudge = (point: { clientX: number; clientY: number }) => ({
      clientX: point.clientX + offset,
      clientY: point.clientY + offset,
      view: window,
    });
    fireEvent.mouseDown(element, { ...start, view: window, button: 0 });
    fireEvent.mouseMove(window, nudge(start));
    fireEvent.mouseMove(window, nudge(end));
    fireEvent.mouseUp(window, nudge(end));
  };

  it("saves a dragged node, moving it out of its system", async () => {
    server.on("PUT /api/canvases/:id/placements", ({ body }) => ({
      saved: (body as { placements: unknown[] }).placements.length,
    }));
    await openCanvas();
    drag(node("Orders API"), { x: 60, y: 100 }, { x: 1260, y: 700 });
    await waitFor(() => expect(server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)).toHaveLength(1));
    const [placement] = (
      server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)[0].body as {
        placements: Array<Record<string, unknown>>;
      }
    ).placements;
    expect(placement).toMatchObject({ entityId: ids.service, parentEntityId: null, width: 220, height: 120 });
  });

  it("moves a node into a system and retries a failed save", async () => {
    let fail = true;
    server.on("PUT /api/canvases/:id/placements", () => (fail ? failWith(500, "Save failed") : { saved: 1 }));
    const { user: actor } = await openCanvas();
    drag(node("Orders DB"), { x: 820, y: 100 }, { x: 120, y: 120 });
    expect(await screen.findByText("Save failed")).toBeTruthy();
    const [placement] = (
      server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)[0].body as {
        placements: Array<Record<string, unknown>>;
      }
    ).placements;
    expect(placement.parentEntityId).toBe(ids.system);

    await actor.click(tool("Auto Neat"));
    expect(await screen.findByText("Retry the failed save before using Auto Neat.")).toBeTruthy();
    fail = false;
    await actor.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Save failed")).toBeNull());
    expect(server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)).toHaveLength(2);
  });

  it("resizes a selected system box and saves it with its children", async () => {
    server.on("PUT /api/canvases/:id/placements", { saved: 2 });
    await openCanvas();
    fireEvent.click(node("Storefront"));
    const handle = await waitFor(() => {
      const found = document.querySelector(".react-flow__resize-control.bottom.right");
      if (!found) throw new Error("resize handle not shown");
      return found;
    });
    drag(handle, { x: 640, y: 400 }, { x: 760, y: 480 }, { measuredFromPress: true });
    await waitFor(() => expect(server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)).toHaveLength(1));
    const { placements } = server.requests("PUT", `/api/canvases/${ids.canvas}/placements`)[0].body as {
      placements: Array<Record<string, unknown>>;
    };
    expect(placements[0]).toMatchObject({ entityId: ids.system, width: 760, height: 480 });
  });
});

describe("panels and collaboration", () => {
  it("opens details from the inspector and switches to the activity log", async () => {
    const { user: actor } = await openCanvas();
    fireEvent.click(node("Orders API"));
    await actor.click(await within(inspector() as HTMLElement).findByRole("button", { name: /Open details/ }));
    const dialog = await screen.findByRole("dialog", { name: "Canvas details" });
    expect(within(dialog).getByText("About this service")).toBeTruthy();
    await actor.click(within(dialog).getByRole("button", { name: "Documentation" }));
    const documentation = await within(dialog).findByRole("textbox", { name: "Documentation" });
    await act(async () => documentation.focus());
    // Escape leaves the documentation editor and keeps the dialog open.
    await actor.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).not.toBe(documentation));
    expect(screen.getByRole("dialog", { name: "Canvas details" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Backspace" });
    await actor.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(window, { key: "Backspace" });
    expect(await screen.findByRole("dialog", { name: "Delete Orders API?" })).toBeTruthy();
    await actor.keyboard("{Escape}");

    await actor.click(screen.getByRole("button", { name: "Toggle activity log" }));
    await waitFor(() => expect(inspector()).toBeNull());
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    fireEvent.click(node("Orders DB"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Toggle activity log" }).getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("shows collaborators' presence, selections, and cursors", async () => {
    await openCanvas();
    const socket = FakeSocket.latest();
    socket.open();
    socket.sent = [];
    fireEvent.click(node("Orders API"));
    await waitFor(() => expect(socket.sent).toContainEqual({ type: "selection", kind: "node", id: ids.service }));
    fireEvent.pointerMove(document.querySelector(".flow-surface") as Element, { clientX: 40, clientY: 40 });
    expect(socket.sent.some((message) => (message as { type: string }).type === "cursor")).toBe(true);

    const now = Date.now();
    socket.receive({
      type: "presence",
      peers: [
        {
          id: "p1",
          name: "Grace",
          colorIndex: 1,
          cursor: { x: 10, y: 20 },
          selection: { kind: "node", id: ids.service },
          lastActiveAt: now,
        },
        {
          id: "p2",
          name: "Linus",
          colorIndex: 2,
          cursor: { x: 5, y: 5 },
          selection: { kind: "connection", id: ids.connection },
          lastActiveAt: now,
        },
        {
          id: "p3",
          name: "Barbara",
          colorIndex: 3,
          cursor: null,
          selection: { kind: "node", id: "gone" },
          lastActiveAt: now - 10 * 60_000,
        },
        { id: "p4", name: "Edsger", colorIndex: 4, cursor: null, selection: null, lastActiveAt: now },
      ],
    });
    const presence = screen.getByRole("region", { name: "People on this canvas" });
    expect(within(presence).getByText("On this canvas · 5")).toBeTruthy();
    expect(within(presence).getByText("Viewing Orders API")).toBeTruthy();
    expect(within(presence).getByText("Viewing Reads orders")).toBeTruthy();
    expect(within(presence).getByText("Away")).toBeTruthy();
    expect(within(presence).getAllByText("Online")).toHaveLength(2);
    expect(screen.getByText("Grace selected")).toBeTruthy();
    expect(screen.getByText("Linus selected")).toBeTruthy();
    expect([...document.querySelectorAll(".live-cursor")].map((cursor) => cursor.textContent)).toEqual([
      "Grace",
      "Linus",
    ]);
  });

  it("shows collaborator selections to viewers too", async () => {
    await openCanvas("viewer");
    const socket = FakeSocket.latest();
    socket.open();
    socket.receive({
      type: "presence",
      peers: [
        {
          id: "p1",
          name: "Grace",
          colorIndex: 1,
          cursor: { x: 1, y: 1 },
          selection: { kind: "node", id: ids.database },
        },
      ],
    });
    expect(screen.getByText("Grace selected")).toBeTruthy();
    fireEvent.pointerMove(document.querySelector(".flow-surface") as Element, { clientX: 5, clientY: 5 });
    expect(socket.sent.some((message) => (message as { type: string }).type === "cursor")).toBe(true);
  });

  it("gives managers sharing and settings shortcuts", async () => {
    server.on("GET /api/canvases/:id", graph().canvas);
    const { user: actor } = await openCanvas("manager");
    expect(screen.getByRole("link", { name: "Manage canvas" }).getAttribute("href")).toBe(
      `/canvases/${ids.canvas}/manage`,
    );
    await actor.click(screen.getByRole("button", { name: "Share canvas" }));
    expect(await screen.findByRole("dialog", { name: "Share canvas" })).toBeTruthy();
  });

  it("expands systems in the sidebar and focuses them on the canvas", async () => {
    const { user: actor } = await openCanvas();
    const systems = screen.getByRole("navigation", { name: "System hierarchy" });
    expect(within(systems).queryByText("Orders API")).toBeNull();
    await actor.click(within(systems).getByRole("button", { name: "Storefront" }));
    expect(within(systems).getByText("Orders API")).toBeTruthy();
    await actor.click(within(systems).getByRole("button", { name: "Collapse Storefront" }));
    expect(within(systems).queryByText("Orders API")).toBeNull();
  });

  it("zooms and fits the canvas", async () => {
    const { user: actor } = await openCanvas();
    const scale = () =>
      Number(
        (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform.match(
          /scale\(([\d.]+)\)/,
        )?.[1],
      );
    const before = scale();
    await actor.click(tool("Zoom in"));
    await waitFor(() => expect(scale()).toBeGreaterThan(before), { timeout: 2000 });
    await actor.click(tool("Zoom out"));
    await actor.click(tool("Fit canvas"));
    await actor.click(tool("Zen mode"));
    expect(tool("Exit Zen mode").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("shared canvas guests", () => {
  it("lets signed-out visitors browse a link-shared canvas", async () => {
    server
      .on("GET /api/auth/me", failWith(401, "Sign in required"))
      .on("GET /api/canvases/:id/access", { role: "viewer" });
    await renderRoute(`/canvases/${ids.canvas}`);
    expect(await screen.findByText("Shared canvas")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in to Wooble" }).getAttribute("href")).toContain("/login?returnTo=");
    expect(await screen.findByText("Orders API")).toBeTruthy();
    const presence = screen.getByRole("region", { name: "People on this canvas" });
    expect(within(presence).getByText("You (you)")).toBeTruthy();
  });

  it("lets signed-out visitors read connection documentation", async () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { documentation: "Orders are read through a replica." } };
    server
      .on("GET /api/auth/me", failWith(401, "Sign in required"))
      .on("GET /api/canvases/:id/access", { role: "viewer" })
      .on("GET /api/canvases/:id/graph", data);
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}`);
    await screen.findByText("Orders API");
    await selectConnection(actor);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });
    expect(within(documentation).getByText("Orders are read through a replica.")).toBeTruthy();
    expectReadOnlyDocumentation(documentation);
    expectReadOnlyRequests();
  });

  it("lets signed-out visitors read long documentation and never reach an editing or writing surface", async () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { documentation: richDocumentation } };
    server
      .on("GET /api/auth/me", failWith(401, "Sign in required"))
      .on("GET /api/canvases/:id/access", { role: "viewer" })
      .on("GET /api/canvases/:id/graph", data)
      .on("PATCH /api/connections/:id", failWith(401, "Sign in required"));
    const { user: actor } = await renderRoute(`/canvases/${ids.canvas}`);
    await screen.findByText("Orders API");
    expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).toBeNull();

    await selectConnection(actor);
    const documentation = await screen.findByRole("region", { name: "Connection documentation" });
    expect(within(documentation).getByRole("heading", { name: "Order intake" })).toBeTruthy();
    expect(documentation.querySelector("pre code")?.textContent).toContain('"retries": 2');
    const table = within(documentation).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Purpose" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "GET /orders" })).toBeTruthy();
    expectReadOnlyDocumentation(documentation);

    // A guest must not be able to leave the reader: no editor, no dialog, and no write on any surface.
    await actor.click(screen.getByRole("button", { name: "Zen mode" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".inspector-panel")).toBeNull();
    await selectConnection(actor);
    expectReadOnlyRequests();
  });

  it("keeps a signed-out guest inside the shared canvas graph", async () => {
    const shared = graph();
    shared.connections[0] = { ...shared.connections[0], metadata: { documentation: "Shared documentation." } };
    server
      .on("GET /api/auth/me", failWith(401, "Sign in required"))
      .on("GET /api/canvases/:id/access", { role: "viewer" })
      .on("GET /api/canvases/:id/graph", shared);
    await renderRoute(`/canvases/${ids.canvas}`);
    await screen.findByText("Orders API");
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(document.querySelector(".react-flow__edge")?.getAttribute("data-id")).toBe(ids.connection);
    expect(document.body.textContent).not.toContain(ids.secondConnection);
    expect(server.requests("GET", `/api/connections/${ids.secondConnection}`)).toHaveLength(0);
    expectReadOnlyRequests();
  });
});
