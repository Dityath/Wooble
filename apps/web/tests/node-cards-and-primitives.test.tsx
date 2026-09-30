import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, createEvent, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useContext, useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../src/components/ui";
import { ConnectorEditContext } from "../src/features/canvas/connector-edit-context";
import { SystemResizeContext } from "../src/features/canvas/system-resize-context";
import { RichDocumentation } from "../src/features/inspector/rich-documentation";
import { CanvasShareDialog } from "../src/features/workspace/canvas-share-dialog";
import type { CanvasGraph } from "../src/lib/api";
import { FakeApi } from "./support/fake-api";
import { installFakeSocket, restoreWebSocket } from "./support/fake-socket";
import { entity, graph, ids, user, workspace } from "./support/fixtures";
import { renderRoute, renderWithQuery } from "./support/render";

let server: FakeApi;
beforeEach(() => {
  installFakeSocket();
  server = new FakeApi().install();
});
afterEach(() => {
  server.restore();
  restoreWebSocket();
});

describe("architecture node cards", () => {
  it("summarizes each kind of node by its technology", async () => {
    const kinds = [
      entity("60000000-0000-4000-8000-000000000001", "frontend", "Web shop", {
        language: "TypeScript",
        framework: "React",
      }),
      entity("60000000-0000-4000-8000-000000000002", "device", "Scale", { technology: "ESP32", language: "C/C++" }),
      entity("60000000-0000-4000-8000-000000000003", "gateway", "", { language: "Lua", framework: "Kong" }),
      entity("60000000-0000-4000-8000-000000000004", "broker", "Events", { technology: "Kafka" }),
      entity("60000000-0000-4000-8000-000000000005", "external", "Card network"),
      entity("60000000-0000-4000-8000-000000000006", "database", "Cache", { engine: "Redis", version: "7" }),
      entity("60000000-0000-4000-8000-000000000007", "service", "Billing", {
        language: "Go",
        framework: "Go",
        status: "planned",
        interfaces: ["gRPC"],
      }),
    ];
    const base = graph();
    const data: CanvasGraph = {
      ...base,
      entities: [...base.entities, ...kinds],
      placements: [
        ...base.placements,
        ...kinds.map((item, index) => ({
          canvasId: ids.canvas,
          entityId: item.id,
          parentEntityId: null,
          x: 1200 + index * 260,
          y: 600,
          width: 220,
          height: 120,
        })),
      ],
      connections: [
        ...base.connections,
        {
          ...base.connections[0],
          id: "40000000-0000-4000-8000-000000000009",
          sourceEntityId: kinds[5].id,
          targetEntityId: kinds[6].id,
        },
      ],
    };
    server
      .on("GET /api/auth/me", user())
      .on("GET /api/workspaces", [workspace()])
      .on("GET /api/canvases/:id/graph", data)
      .on("GET /api/canvases/:id/access", { role: "viewer" });
    await renderRoute(`/canvases/${ids.canvas}`);
    await screen.findByText("Web shop");

    const card = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".architecture-node")].find(
        (element) => element.querySelector(".architecture-node-name")?.textContent === name,
      ) as HTMLElement;
    const tech = (name: string) => card(name).querySelector(".architecture-node-tech")?.textContent;

    expect(within(card("Web shop")).getByText("Frontend")).toBeTruthy();
    expect(tech("Web shop")).toBe("TypeScript·React");
    expect(card("Web shop").querySelectorAll(".technology-icon")).toHaveLength(2);
    expect(tech("Scale")).toBe("ESP32");
    expect(within(card("New node")).getByText("API gateway")).toBeTruthy();
    expect(tech("New node")).toBe("Lua·Kong");
    expect(tech("Events")).toBe("Kafka");
    expect(tech("Card network")).toBe("External system");
    expect(tech("Cache")).toBe("Redis·Version 7");
    expect(tech("Orders DB")).toBe("PostgreSQL·Data store");
    expect(tech("Billing")).toBe("Go");
    expect(card("Billing").querySelector(".status-dot")?.getAttribute("title")).toBe("planned");
    expect(card("Billing").querySelector(".architecture-node-subtitle")?.textContent).toBe("gRPC · Redis");
    expect(card("Orders API").querySelector(".architecture-node-subtitle")?.textContent).toBe("PostgreSQL");
  });
});

describe("shared component defaults", () => {
  it("keeps connector editing and system resizing off without an editor", async () => {
    const edit = renderHook(() => useContext(ConnectorEditContext)).result.current;
    const resize = renderHook(() => useContext(SystemResizeContext)).result.current;
    expect(edit.editing).toBe(false);
    await expect(edit.saveBend("connection", null)).resolves.toBeUndefined();
    expect(resize.enabled).toBe(false);
    expect(resize.canResize("system", { x: 0, y: 0, width: 400, height: 300 })).toBe(false);
    expect(() => {
      resize.onStart("system");
      resize.onEnd("system", { x: 0, y: 0, width: 400, height: 300 });
    }).not.toThrow();
  });

  it("renders the card slots with their styling hooks", () => {
    render(
      <Card className="extra">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Title" }).className).toBe("ui-card-title");
    expect(screen.getByText("Description").className).toBe("ui-card-description");
    expect(screen.getByText("Body").className).toBe("ui-card-content");
    expect(screen.getByText("Footer").className).toBe("ui-card-footer");
    expect(screen.getByText("Body").parentElement?.className).toBe("ui-card extra");
    expect(screen.getByText("Title").parentElement?.className).toBe("ui-card-header");
  });
});

describe("small interaction details", () => {
  it("resets the copied confirmation after two seconds", async () => {
    server.on("GET /api/canvases/:id", { ...graph().canvas, shareMode: "link" });
    const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    function Harness() {
      const [open, setOpen] = useState(true);
      return <CanvasShareDialog canvasId={ids.canvas} open={open} onOpenChange={setOpen} />;
    }
    renderWithQuery(<Harness />);
    const button = await screen.findByRole("button", { name: "Copy link" });
    // Capture the reset timer without leaving setTimeout mocked while Testing Library waits.
    const timers = spyOn(globalThis, "setTimeout");
    await act(async () => {
      fireEvent.click(button);
    });
    const reset = timers.mock.calls.find(([, delay]) => delay === 2000)?.[0] as () => void;
    timers.mockRestore();
    copy.mockRestore();
    expect(button.textContent).toBe("Copied");
    act(() => reset());
    expect(button.textContent).toBe("Copy link");
  });

  it("keeps the documentation editor focused when Cancel is pressed", async () => {
    const { user: actor } = renderWithQuery(<RichDocumentation value="Text" onSave={mock(async () => {})} />);
    await actor.click(screen.getByRole("button", { name: "Edit" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const pointerDown = createEvent.pointerDown(cancel);
    fireEvent(cancel, pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
  });
});
