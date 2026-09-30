import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ArchitectureEntity } from "@wooble/domain";
import { useState } from "react";
import { InspectorPanel } from "../src/features/inspector/inspector-panel";
import type { CanvasGraph } from "../src/lib/api";
import { useEditorStore } from "../src/stores/editor-store";
import { FakeApi, failWith } from "./support/fake-api";
import { entity, graph, ids } from "./support/fixtures";
import { renderWithQuery } from "./support/render";

let server: FakeApi;
beforeEach(() => {
  server = new FakeApi().install();
  useEditorStore.setState({ selectedEntityId: null, selectedConnectionId: null, positions: {} });
});
afterEach(() => server.restore());

const selectEntity = (id: string) => useEditorStore.getState().setEntitySelected(id);
const selectConnection = (id: string) => useEditorStore.getState().setConnectionSelected(id);

function withEntities(...extra: ArchitectureEntity[]): CanvasGraph {
  const base = graph();
  return {
    ...base,
    entities: [...base.entities, ...extra],
    placements: [
      ...base.placements,
      ...extra.map((item, index) => ({
        canvasId: ids.canvas,
        entityId: item.id,
        parentEntityId: null,
        x: 1200 + index * 300,
        y: 0,
        width: 220,
        height: 120,
      })),
    ],
  };
}

function renderPanel(props: Partial<Parameters<typeof InspectorPanel>[0]> = {}, data: CanvasGraph = graph()) {
  const onOpenDetails = mock((_section: string) => {});
  const view = renderWithQuery(
    <InspectorPanel graph={data} canvasId={ids.canvas} onOpenDetails={onOpenDetails} {...props} />,
  );
  return { ...view, onOpenDetails };
}

describe("inspector overview", () => {
  it("summarizes a service with its database, protocols, and source links", async () => {
    const data = graph();
    data.entities[1] = entity(
      ids.service,
      "service",
      "Orders API",
      {
        language: "TypeScript",
        status: "in-progress",
        interfaces: ["REST", "gRPC"],
        repositoryUrl: "git.example.test/orders",
        artifactUrl: "not a url",
      },
      "Accepts orders",
    );
    selectEntity(ids.service);
    const { onOpenDetails, user } = renderPanel({}, data);

    expect(screen.getByRole("heading", { name: "Orders API" })).toBeTruthy();
    expect(screen.getByText("Service")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.getByText("Accepts orders")).toBeTruthy();
    expect(screen.getByText("Framework not set")).toBeTruthy();
    expect(screen.getByText("gRPC")).toBeTruthy();
    expect(screen.getByText("Orders DB")).toBeTruthy();
    expect(screen.getByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByRole("link", { name: /git.example.test\/orders/ }).getAttribute("href")).toBe(
      "https://git.example.test/orders",
    );
    expect(screen.getByText("not a url")).toBeTruthy();
    expect(screen.getByText("Updated Sep 1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Open details/ }));
    await user.click(screen.getByRole("button", { name: "Documentation" }));
    expect(onOpenDetails.mock.calls.map(([section]) => section)).toEqual(["overview", "documentation"]);

    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it("lists a system's components", () => {
    selectEntity(ids.system);
    renderPanel();
    expect(screen.getByRole("heading", { name: "Storefront" })).toBeTruthy();
    expect(screen.getByText("COMPONENTS")).toBeTruthy();
    expect(screen.getByText("Orders API")).toBeTruthy();
  });

  it("shows a database's engine, version, connected services, and schema shortcut", async () => {
    const data = graph();
    data.entities[2] = entity(ids.database, "database", "Orders DB", { engine: "PostgreSQL", version: "16" });
    selectEntity(ids.database);
    const { onOpenDetails, user } = renderPanel({}, data);
    expect(screen.getByText("16")).toBeTruthy();
    expect(
      within(screen.getByText("CONNECTED SERVICES").closest("section") as HTMLElement).getByText("Orders API"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Database schema" }));
    expect(onOpenDetails).toHaveBeenCalledWith("schema");
  });

  it("falls back when details are missing", () => {
    const lonely = entity(ids.gateway, "database", "");
    selectEntity(ids.gateway);
    renderPanel({ onOpenDetails: undefined }, withEntities(lonely));
    expect(screen.getByRole("heading", { name: "New node" })).toBeTruthy();
    expect(screen.getByText("Engine not set")).toBeTruthy();
    expect(screen.getByText("No services connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open details/ })).toBeNull();
  });

  it("describes edge nodes by their technology and connections", () => {
    const device = entity(ids.gateway, "device", "Scale", {
      technology: "ESP32",
      framework: "Arduino",
      artifactUrl: "https://firmware.example.test/scale.bin",
    });
    const data = withEntities(device);
    data.connections.push({
      ...data.connections[0],
      id: ids.secondConnection,
      sourceEntityId: ids.gateway,
      targetEntityId: ids.service,
      type: "mqtt",
      label: "Weights",
    });
    selectEntity(ids.gateway);
    renderPanel({}, data);
    expect(screen.getByText("IoT device")).toBeTruthy();
    expect(screen.getByText("ESP32")).toBeTruthy();
    expect(screen.getByText("Arduino")).toBeTruthy();
    expect(screen.getByText("Weights")).toBeTruthy();
    expect(screen.getByRole("link", { name: /firmware.example.test/ })).toBeTruthy();
  });

  it("shows an unconnected frontend and its grouped tech stack", () => {
    const web = entity(ids.gateway, "frontend", "Web app", {
      technologyStack: ["react", "typescript"],
      technologyVersions: { react: "19" },
    });
    selectEntity(ids.gateway);
    renderPanel({}, withEntities(web));
    expect(screen.getByText("No connections yet")).toBeTruthy();
    expect(screen.getByText("React 19")).toBeTruthy();
    expect(screen.queryByText("TECHNOLOGY")).toBeNull();
  });

  it("groups device technologies and keeps unrelated earlier choices", () => {
    const device = entity(ids.gateway, "device", "Sensor hub", {
      technologyStack: ["esp32", "dht22", "postgresql", "unknown-tech"],
    });
    selectEntity(ids.gateway);
    renderPanel({}, withEntities(device));
    expect(screen.getByText("Hardware")).toBeTruthy();
    expect(screen.getByText("Sensors")).toBeTruthy();
    expect(screen.getByText("Previously selected")).toBeTruthy();
    expect(screen.getByText("unknown-tech")).toBeTruthy();
  });

  it("describes a connection's flow and contract", async () => {
    const data = graph();
    data.connections[0] = {
      ...data.connections[0],
      description: "Reads the order table",
      metadata: { contract: "orders.v1", contractBody: "openapi: 3.0.0" },
    };
    selectConnection(ids.connection);
    const { onOpenDetails, user } = renderPanel({}, data);
    expect(screen.getByRole("heading", { name: "Reads orders" })).toBeTruthy();
    expect(screen.getByText("DATABASE")).toBeTruthy();
    expect(screen.getByText("Reads the order table")).toBeTruthy();
    expect(screen.getByText("orders.v1")).toBeTruthy();
    expect(screen.getByText("Open details to view or edit the contract.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Contract" }));
    expect(onOpenDetails).toHaveBeenCalledWith("contract");
  });

  it("names unknown endpoints and invites adding a contract", () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], sourceEntityId: ids.gateway, type: "grpc", metadata: {} };
    selectConnection(ids.connection);
    renderPanel({}, data);
    expect(screen.getByText("Unknown entity")).toBeTruthy();
    expect(screen.getByText("Open details to add OpenAPI, Proto, or contract notes.")).toBeTruthy();
  });

  it("shows an empty state when the selection no longer exists", () => {
    selectEntity("missing");
    renderPanel();
    expect(screen.getByText("Select an item")).toBeTruthy();
  });
});

describe("inspector deletion", () => {
  it("deletes a system and its contained nodes after confirmation", async () => {
    server.on("DELETE /api/canvases/:canvasId/entities/:entityId", {
      kind: "deleted",
      removedNodes: 2,
      removedConnections: 1,
    });
    selectEntity(ids.system);
    const { user } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Storefront?" });
    expect(
      within(dialog).getByText(
        "This removes the system and 1 contained node, plus their connections, from this canvas.",
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(useEditorStore.getState().selectedEntityId).toBeNull());
    expect(server.requests("DELETE", `/api/canvases/${ids.canvas}/entities/${ids.system}`)).toHaveLength(1);
  });

  it("explains the impact for larger systems, single nodes, and connections", async () => {
    const data = graph();
    data.placements[2] = { ...data.placements[2], parentEntityId: ids.system };
    selectEntity(ids.system);
    const system = renderPanel({}, data);
    await system.user.click(screen.getByRole("button", { name: /Delete/ }));
    expect(await screen.findByText(/and 2 contained nodes/)).toBeTruthy();
    system.unmount();

    selectEntity(ids.database);
    const node = renderPanel();
    await node.user.click(screen.getByRole("button", { name: /Delete/ }));
    expect(await screen.findByText("This removes the node and its connections from this canvas.")).toBeTruthy();
    await node.user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    node.unmount();

    server.on("DELETE /api/canvases/:canvasId/connections/:connectionId", failWith(409, "Connection changed"));
    selectConnection(ids.connection);
    const edge = renderPanel();
    await edge.user.click(screen.getByRole("button", { name: /Delete/ }));
    expect(await screen.findByText("This removes the connection from this canvas.")).toBeTruthy();
    await edge.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Delete/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection changed");
    expect(useEditorStore.getState().selectedConnectionId).toBe(ids.connection);
  });

  it("opens the confirmation for new keyboard delete requests only", async () => {
    selectEntity(ids.database);
    function Harness() {
      const [request, setRequest] = useState<{ serial: number } | null>({ serial: 1 });
      return (
        <>
          <button type="button" onClick={() => setRequest({ serial: 2 })}>
            Press Delete
          </button>
          <InspectorPanel graph={graph()} canvasId={ids.canvas} deleteRequest={request} />
        </>
      );
    }
    const { user } = renderWithQuery(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Press Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete Orders DB?" })).toBeTruthy();
  });
});

describe("inline node settings", () => {
  const openSettings = async (user: ReturnType<typeof renderWithQuery>["user"]) => {
    await user.click(screen.getByRole("button", { name: "Edit in sidebar" }));
    expect(screen.getByRole("heading", { name: /Edit (node|system|connection)/ })).toBeTruthy();
  };

  it("renames a node with Enter and requires a name", async () => {
    server.on("PATCH /api/entities/:id", {});
    selectEntity(ids.service);
    const { user } = renderPanel();
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Edit name" }));
    const name = screen.getByLabelText<HTMLInputElement>("Name");
    expect(document.activeElement).toBe(name);
    expect(screen.getByText("Click outside or press Enter to save · Cancel or Esc to discard")).toBeTruthy();
    await user.clear(name);
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Name is required.");

    await user.type(screen.getByLabelText("Name"), "Order Service{Enter}");
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    expect(server.requests("PATCH", `/api/entities/${ids.service}`)[0].body).toEqual({ name: "Order Service" });
  });

  it("discards edits with Escape or Cancel and skips unchanged values", async () => {
    selectEntity(ids.service);
    const { user } = renderPanel();
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Edit name" }));
    await user.type(screen.getByLabelText("Name"), " changed{Escape}");
    await user.click(screen.getByRole("button", { name: "Edit description" }));
    expect(screen.getByText("Click outside or press Ctrl/⌘ Enter to save · Cancel or Esc to discard")).toBeTruthy();
    await user.type(screen.getByLabelText("Description"), "Draft");
    await user.click(screen.getByRole("button", { name: "Cancel editing description" }));
    await user.click(screen.getByRole("button", { name: "Edit name" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Edit type" }));
    fireEvent.keyDown(screen.getByLabelText("Type"), { key: "Escape" });
    expect(server.calls).toEqual([]);
    expect(screen.getByText("Orders API")).toBeTruthy();
  });

  it("saves the description, type, status, and source fields", async () => {
    server.on("PATCH /api/entities/:id", {});
    selectEntity(ids.service);
    const { user } = renderPanel();
    await openSettings(user);

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.type(screen.getByLabelText("Description"), "Handles checkout{Control>}{Enter}{/Control}");
    await waitFor(() => expect(server.calls).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Edit type" }));
    expect(screen.getByText("Choose an option to save · Cancel or Esc to discard")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Type"), "gateway");
    await waitFor(() => expect(server.calls).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Edit status" }));
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => expect(server.calls).toHaveLength(3));

    await user.click(screen.getByRole("button", { name: "Edit repository url" }));
    await user.type(screen.getByLabelText("Repository URL"), "https://git.example.test/orders");
    fireEvent.blur(screen.getByLabelText("Repository URL"));
    await waitFor(() => expect(server.calls).toHaveLength(4));

    expect(server.calls.map((call) => call.body)).toEqual([
      { description: "Handles checkout" },
      { type: "gateway" },
      { metadata: { status: null } },
      { metadata: { repositoryUrl: "https://git.example.test/orders" } },
    ]);
  });

  it("clears an emptied description and edits a database version", async () => {
    server.on("PATCH /api/entities/:id", {});
    const data = graph();
    data.entities[2] = entity(ids.database, "database", "Orders DB", {}, "Primary store");
    selectEntity(ids.database);
    const { user } = renderPanel({}, data);
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.clear(screen.getByLabelText("Description"));
    fireEvent.blur(screen.getByLabelText("Description"));
    await waitFor(() => expect(server.calls).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Edit version" }));
    await user.type(screen.getByLabelText("Version"), "16{Enter}");
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls.map((call) => call.body)).toEqual([{ description: null }, { metadata: { version: "16" } }]);
  });

  it("shows save errors in place and opens the technology picker", async () => {
    server.on("PATCH /api/entities/:id", failWith(400, "Name is too long"));
    selectEntity(ids.service);
    const { user } = renderPanel();
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Edit name" }));
    await user.type(screen.getByLabelText("Name"), "!{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Name is too long");
    await user.click(screen.getByRole("button", { name: "Cancel editing name" }));

    const techEdit = screen
      .getAllByRole("button", { name: /Edit/ })
      .find((button) => button.closest(".inspector-field")?.textContent?.includes("Technology stack")) as HTMLElement;
    await user.click(techEdit);
    expect(await screen.findByRole("dialog", { name: "Technology stack" })).toBeTruthy();
  });

  it("edits a system without node-only fields and returns to the overview", async () => {
    selectEntity(ids.system);
    const { user } = renderPanel();
    await openSettings(user);
    expect(screen.getByRole("heading", { name: "Edit system" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit type" })).toBeNull();
    expect(screen.queryByText("Technology stack")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Back to overview/ }));
    expect(screen.getByText("COMPONENTS")).toBeTruthy();
  });
});

describe("inline connection settings", () => {
  it("edits every connection field and requires a label", async () => {
    server.on("PATCH /api/connections/:id", {});
    selectConnection(ids.connection);
    const { user } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Edit in sidebar" }));
    expect(screen.getByRole("region", { name: "Connection settings" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit protocol" }));
    await user.selectOptions(screen.getByLabelText("Protocol"), "grpc");
    await waitFor(() => expect(server.calls).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Edit label" }));
    await user.clear(screen.getByLabelText("Label"));
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Label is required.");
    await user.type(screen.getByLabelText("Label"), "Loads orders{Enter}");
    await waitFor(() => expect(server.calls).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.type(screen.getByLabelText("Description"), "Nightly{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(server.calls).toHaveLength(3));

    await user.click(screen.getByRole("button", { name: "Edit contract reference" }));
    await user.type(screen.getByLabelText("Contract reference"), "orders.v2{Enter}");
    await waitFor(() => expect(server.calls).toHaveLength(4));

    await user.click(screen.getByRole("button", { name: "Edit direction" }));
    await user.selectOptions(screen.getByLabelText("Direction"), "two-way");
    await waitFor(() => expect(server.calls).toHaveLength(5));

    expect(server.calls.map((call) => call.body)).toEqual([
      { type: "grpc" },
      { label: "Loads orders" },
      { description: "Nightly" },
      { metadata: { contract: "orders.v2" } },
      { metadata: { direction: "two-way" } },
    ]);
  });

  it("clears optional fields, discards edits, and reports failures", async () => {
    server.on("PATCH /api/connections/:id", failWith(409, "Connection changed"));
    const data = graph();
    data.connections[0] = { ...data.connections[0], description: "Old", metadata: { contract: "v1" } };
    selectConnection(ids.connection);
    const { user } = renderPanel({}, data);
    await user.click(screen.getByRole("button", { name: "Edit in sidebar" }));

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.type(screen.getByLabelText("Description"), " text{Escape}");
    await user.click(screen.getByRole("button", { name: "Edit label" }));
    await user.type(screen.getByLabelText("Label"), " x{Escape}");
    await user.click(screen.getByRole("button", { name: "Edit direction" }));
    fireEvent.keyDown(screen.getByLabelText("Direction"), { key: "Escape" });
    await user.click(screen.getByRole("button", { name: "Edit protocol" }));
    await user.click(screen.getByRole("button", { name: "Cancel editing protocol" }));
    await user.click(screen.getByRole("button", { name: "Edit label" }));
    await user.keyboard("{Enter}");
    expect(server.calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Edit description" }));
    await user.clear(screen.getByLabelText("Description"));
    fireEvent.blur(screen.getByLabelText("Description"));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection changed");
    expect(server.calls[0].body).toEqual({ description: null });
    await user.click(screen.getByRole("button", { name: "Cancel editing description" }));

    await user.click(screen.getByRole("button", { name: "Edit contract reference" }));
    await user.clear(screen.getByLabelText("Contract reference"));
    fireEvent.blur(screen.getByLabelText("Contract reference"));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1].body).toEqual({ metadata: { contract: null } });
  });
});

describe("inspector details", () => {
  type Section = "overview" | "documentation" | "schema" | "contract";
  function Details({ data = graph(), initial = "overview" }: { data?: CanvasGraph; initial?: Section }) {
    const [section, setSection] = useState<Section>(initial);
    return (
      <InspectorPanel
        graph={data}
        canvasId={ids.canvas}
        mode="details"
        detailSection={section}
        onSelectDetailSection={setSection}
      />
    );
  }

  it("shows entity facts and saves documentation and schema", async () => {
    server.on("PATCH /api/entities/:id", {});
    const data = graph();
    data.entities[2] = entity(ids.database, "database", "Orders DB", {
      engine: "PostgreSQL",
      status: "planned",
      technologyStack: ["postgresql", "docker"],
    });
    selectEntity(ids.database);
    const { user } = renderWithQuery(<Details data={data} />);
    expect(screen.getByText("About this database")).toBeTruthy();
    expect(screen.getByText("planned")).toBeTruthy();
    expect(screen.getByText("postgresql, docker")).toBeTruthy();
    expect(screen.getByText("No description yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit in sidebar" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Database schema" }));
    expect(screen.getByRole("button", { name: "Database schema" }).getAttribute("aria-current")).toBe("page");
    fireEvent.change(screen.getByLabelText("SQL schema"), { target: { value: "CREATE TABLE t (id INT);" } });
    await user.click(screen.getByRole("button", { name: "Save schema" }));
    await waitFor(() => expect(server.calls).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Documentation" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Documentation Markdown"), "# Backups");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls.map((call) => call.body)).toEqual([
      { metadata: { schemaSql: "CREATE TABLE t (id INT);" } },
      { metadata: { documentation: "# Backups" } },
    ]);
  });

  it("counts a system's direct components", () => {
    selectEntity(ids.system);
    renderWithQuery(<Details />);
    expect(screen.getByText("Direct components")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Database schema" })).toBeNull();
  });

  it("shows connection facts and saves the contract and documentation", async () => {
    server.on("PATCH /api/connections/:id", {});
    const data = graph();
    data.connections[0] = { ...data.connections[0], metadata: { contract: "orders.v1" } };
    selectConnection(ids.connection);
    const { user } = renderWithQuery(<Details data={data} />);
    expect(screen.getByText("Orders API → Orders DB")).toBeTruthy();
    expect(screen.getByText("Connection overview")).toBeTruthy();
    expect(screen.getByText("orders.v1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Contract" }));
    await user.click(screen.getByRole("tab", { name: "Source" }));
    await user.type(screen.getByLabelText("Contract source"), "SELECT 1");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(server.calls).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Documentation" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Documentation Markdown"), "Read replica");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls.map((call) => call.body)).toEqual([
      { metadata: { contractBody: "SELECT 1" } },
      { metadata: { documentation: "Read replica" } },
    ]);
  });

  it("names missing endpoints in connection details", () => {
    const data = graph();
    data.connections[0] = { ...data.connections[0], sourceEntityId: ids.gateway, targetEntityId: ids.event };
    selectConnection(ids.connection);
    renderWithQuery(<Details data={data} />);
    expect(screen.getByText("Source → Target")).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
  });
});
