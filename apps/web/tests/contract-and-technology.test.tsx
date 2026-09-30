import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { ContractEditor, ContractPreview } from "../src/features/inspector/contract-editor";
import { TechnologyDialog } from "../src/features/inspector/technology-dialog";
import { TechnologyIcon, TechnologyName } from "../src/features/inspector/technology-icon";
import { FakeApi, failWith } from "./support/fake-api";
import { entity, ids } from "./support/fixtures";
import { renderWithQuery } from "./support/render";

const ordersApi = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Orders", version: "2.1.0" },
  paths: {
    "/orders": {
      get: {
        summary: "List orders",
        description: "Newest first",
        parameters: [{ name: "status", in: "query" }, {}],
        responses: { "200": { description: "Order page" }, "401": {} },
      },
      post: { summary: "Place order", "x-internal": true },
      parameters: [],
    },
    "/health": null,
  },
});

describe("contract preview", () => {
  it("lists OpenAPI operations with their details", async () => {
    const { user } = renderWithQuery(<ContractPreview value={ordersApi} kind="rest" />);
    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.getByText("OpenAPI 2.1.0")).toBeTruthy();
    expect(screen.getByText("List orders")).toBeTruthy();
    await user.click(screen.getByText("List orders"));
    expect(screen.getByText("Newest first")).toBeTruthy();
    expect(screen.getByText("status · query, Parameter · query")).toBeTruthy();
    expect(screen.getByText("Order page")).toBeTruthy();
    expect(screen.getByText("Place order")).toBeTruthy();
  });

  it("reads YAML, defaults missing info, and handles documents without operations", () => {
    renderWithQuery(<ContractPreview value={"openapi: 3.0.0\npaths: {}\n"} kind="rest" />);
    expect(screen.getByText("API")).toBeTruthy();
    expect(screen.getByText("OpenAPI 1.0.0")).toBeTruthy();
    expect(screen.getByText("No operations in this contract.")).toBeTruthy();
  });

  it("shows other protocols and invalid documents as raw text", () => {
    renderWithQuery(
      <>
        <ContractPreview value={"service Orders {}"} kind="grpc" />
        <ContractPreview value={"{ not json"} kind="rest" />
        <ContractPreview value={JSON.stringify({ swagger: "2.0" })} kind="rest" />
        <ContractPreview value="" kind="rest" />
      </>,
    );
    expect(screen.getByText("service Orders {}")).toBeTruthy();
    expect(screen.getByText("{ not json")).toBeTruthy();
    expect(screen.getByText("No contract yet.")).toBeTruthy();
  });
});

describe("contract editor", () => {
  it("edits operations visually and saves a generated OpenAPI document", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user } = renderWithQuery(<ContractEditor value={ordersApi} kind="rest" onSave={onSave} />);
    await user.click(screen.getByRole("tab", { name: "Visual editor" }));

    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Orders API");
    await user.clear(screen.getByLabelText("Version"));
    await user.type(screen.getByLabelText("Version"), "3.0.0");
    await user.selectOptions(screen.getByLabelText("Method 2"), "PUT");
    await user.clear(screen.getByLabelText("Summary 2"));
    await user.type(screen.getByLabelText("Summary 2"), "Replace order");
    await user.click(screen.getByRole("button", { name: /Add endpoint/ }));
    await user.type(screen.getByLabelText("Path 3"), "refunds");
    await user.type(screen.getByLabelText("Summary 3"), "Refund order");
    await user.click(screen.getByRole("button", { name: /Add endpoint/ }));
    await user.click(screen.getByRole("button", { name: "Remove operation 1" }));
    await user.click(screen.getByRole("button", { name: "Save contract" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(onSave.mock.calls[0][0]);
    expect(saved.info).toEqual({ title: "Orders API", version: "3.0.0" });
    expect(saved.paths["/orders"]).toEqual({
      put: { responses: { "200": { description: "Successful response" } }, summary: "Replace order" },
    });
    expect(saved.paths["/refunds"].get.summary).toBe("Refund order");
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("starts a visual contract from an empty document", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user } = renderWithQuery(<ContractEditor value="" kind="rest" onSave={onSave} />);
    await user.click(screen.getByRole("tab", { name: "Visual editor" }));
    await user.clear(screen.getByLabelText("Title"));
    await user.clear(screen.getByLabelText("Version"));
    await user.click(screen.getByRole("button", { name: /Add endpoint/ }));
    await user.type(screen.getByLabelText("Path 1"), "/ping");
    await user.click(screen.getByRole("button", { name: "Save contract" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(JSON.parse(onSave.mock.calls[0][0])).toEqual({
      openapi: "3.1.0",
      info: { title: "API", version: "1.0.0" },
      paths: { "/ping": { get: { responses: { "200": { description: "Successful response" } }, summary: "" } } },
    });
  });

  it("edits the source, warns about invalid OpenAPI, and discards with Escape", async () => {
    const onSave = mock(async (_value: string) => {});
    const { user } = renderWithQuery(<ContractEditor value={ordersApi} kind="rest" onSave={onSave} />);
    await user.click(screen.getByRole("tab", { name: "Source" }));
    const source = screen.getByLabelText<HTMLTextAreaElement>("Contract source");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save source" }).disabled).toBe(true);
    fireEvent.change(source, { target: { value: "not: [valid" } });
    expect(screen.getByText("OpenAPI preview requires a valid document")).toBeTruthy();
    fireEvent.keyDown(source, { key: "Escape" });
    expect(screen.getByText("List orders")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Source" }));
    fireEvent.change(screen.getByLabelText("Contract source"), { target: { value: "openapi: 3.0.0\npaths: {}" } });
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("openapi: 3.0.0\npaths: {}"));
  });

  it("shows save errors", async () => {
    const onSave = mock(async (_value: string) => {
      throw new Error("Contract rejected");
    });
    const { user } = renderWithQuery(<ContractEditor value="" kind="grpc" onSave={onSave} />);
    expect(screen.getByRole("heading", { name: "Connection contract" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Visual editor" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Source" }));
    await user.type(screen.getByLabelText("Contract source"), "service Orders {{}}");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Contract rejected");
  });

  it("imports a valid OpenAPI file and rejects invalid or large files", async () => {
    const { container, user } = renderWithQuery(<ContractEditor value="" kind="rest" onSave={async () => {}} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]") as HTMLInputElement;
    const clicked = mock(() => {});
    input.addEventListener("click", clicked);
    await user.click(screen.getByRole("button", { name: /Import/ }));
    expect(clicked).toHaveBeenCalled();

    const upload = (file: File) => fireEvent.change(input, { target: { files: [file] } });
    upload(new File(["x".repeat(100_001)], "big.json"));
    expect((await screen.findByRole("alert")).textContent).toBe("OpenAPI file must be under 100 KB");
    upload(new File(["just text"], "notes.txt"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Import a valid OpenAPI 3 JSON or YAML document"),
    );
    upload(new File([ordersApi], "orders.json"));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Contract source").value).toBe(ordersApi));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { files: [] } });
  });

  it("keeps local edits when the saved contract changes elsewhere", async () => {
    const { rerender, user } = renderWithQuery(<ContractEditor value="a" kind="grpc" onSave={async () => {}} />);
    await user.click(screen.getByRole("tab", { name: "Source" }));
    fireEvent.change(screen.getByLabelText("Contract source"), { target: { value: "local" } });
    rerender(<ContractEditor value="b" kind="grpc" onSave={async () => {}} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Contract source").value).toBe("local");
  });
});

describe("technology dialog", () => {
  let server: FakeApi;
  beforeEach(() => {
    server = new FakeApi().install();
  });
  afterEach(() => server.restore());

  function Harness({ node }: { node: ReturnType<typeof entity> }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <span>{open ? "open" : "closed"}</span>
        <TechnologyDialog entity={node} canvasId={ids.canvas} open={open} onOpenChange={setOpen} />
      </>
    );
  }

  it("preselects legacy metadata and saves the chosen stack with versions", async () => {
    server.on("PATCH /api/entities/:id", ({ body }) => ({
      ...entity(ids.service, "service", "Orders"),
      ...(body as object),
    }));
    const service = entity(ids.service, "service", "Orders API", {
      language: "TypeScript",
      framework: "Express",
      interfaces: ["gRPC"],
    });
    const { user } = renderWithQuery(<Harness node={service} />);
    const dialog = await screen.findByRole("dialog", { name: "Technology stack" });
    expect(within(dialog).getByText("Selected (3)")).toBeTruthy();

    await user.type(within(dialog).getByPlaceholderText("Search technologies"), "postg");
    await user.click(within(dialog).getByRole("checkbox", { name: /PostgreSQL/ }));
    await user.clear(within(dialog).getByPlaceholderText("Search technologies"));
    await user.type(within(dialog).getByLabelText("PostgreSQL version"), " 16 ");
    await user.type(within(dialog).getByPlaceholderText("Search technologies"), "express");
    await user.click(within(dialog).getByRole("checkbox", { name: /Express/ }));
    await user.clear(within(dialog).getByPlaceholderText("Search technologies"));
    await user.click(within(dialog).getByRole("button", { name: "Save technology" }));

    await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
    const { metadata } = server.requests("PATCH", `/api/entities/${ids.service}`)[0].body as {
      metadata: Record<string, unknown>;
    };
    expect(metadata).toMatchObject({
      technologyVersions: { postgresql: "16" },
      language: "TypeScript",
      framework: null,
      interfaces: ["gRPC"],
    });
    expect(metadata.technologyStack).toEqual(expect.arrayContaining(["typescript", "grpc", "postgresql"]));
    expect(metadata.technologyStack).not.toContain("express");
  });

  it("keeps technologies from other node types as previously selected", async () => {
    const device = entity(ids.gateway, "device", "", {
      technologyStack: ["esp32", "typescript"],
      technologyVersions: {},
    });
    const { user } = renderWithQuery(<Harness node={device} />);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Select the technologies used by this node, then enter their versions."),
    ).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Previously selected" })).toBeTruthy();
    await user.type(within(dialog).getByPlaceholderText("Search technologies"), "zzzz");
    expect(within(dialog).getByText("No matching technologies in the catalog.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
  });

  it("saves database engines and frontend frameworks into the legacy summary", async () => {
    server.on("PATCH /api/entities/:id", {});
    const database = entity(ids.database, "database", "Orders DB", { technologyStack: [] });
    const { user } = renderWithQuery(<Harness node={database} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Select a technology to set its version.")).toBeTruthy();
    await user.click(within(dialog).getByRole("checkbox", { name: /MySQL/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save technology" }));
    await waitFor(() => expect(server.calls).toHaveLength(1));
    expect((server.calls[0].body as { metadata: { engine: string } }).metadata.engine).toBe("MySQL");
  });

  it("uses frontend frameworks first for frontend nodes", async () => {
    server.on("PATCH /api/entities/:id", {});
    const frontend = entity(ids.gateway, "frontend", "Web", { technologyStack: ["react"] });
    const { user } = renderWithQuery(<Harness node={frontend} />);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save technology" }));
    await waitFor(() => expect(server.calls).toHaveLength(1));
    expect((server.calls[0].body as { metadata: { framework: string } }).metadata.framework).toBe("React");
  });

  it("shows why the stack could not be saved", async () => {
    server.on("PATCH /api/entities/:id", failWith(400, "Too many technologies"));
    const { user } = renderWithQuery(<Harness node={entity(ids.service, "service", "Orders API")} />);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save technology" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many technologies");
    expect(screen.getByText("open")).toBeTruthy();
  });
});

describe("technology icons", () => {
  it("uses brand marks when available and category icons otherwise", () => {
    const { container } = renderWithQuery(
      <>
        <TechnologyIcon id="postgresql" />
        <TechnologyIcon id="dht22" />
        <TechnologyIcon id="not-in-catalog" />
        <TechnologyName id="react" label="React" version="19" />
      </>,
    );
    expect(container.querySelectorAll("svg.technology-icon")).toHaveLength(4);
    expect(container.querySelector("svg.technology-icon path")?.getAttribute("d")).toBeTruthy();
    expect(screen.getByText("React 19")).toBeTruthy();
  });
});
