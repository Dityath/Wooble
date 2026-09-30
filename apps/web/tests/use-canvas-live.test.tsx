import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCanvasLive } from "../src/features/canvas/use-canvas-live";
import { FakeSocket, installFakeSocket, restoreWebSocket } from "./support/fake-socket";
import { ids } from "./support/fixtures";
import { testQueryClient } from "./support/render";

beforeEach(installFakeSocket);
afterEach(restoreWebSocket);

function setup(enabled = true) {
  const queryClient = testQueryClient();
  const invalidate = spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useCanvasLive(ids.canvas, enabled), { wrapper });
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { ...hook, invalidatedKeys, socket: () => FakeSocket.instances.at(-1) as FakeSocket };
}

describe("useCanvasLive", () => {
  it("stays offline when live collaboration is disabled", () => {
    setup(false);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("connects over ws, announces the current selection, and refreshes the graph", () => {
    const { result, socket, invalidatedKeys } = setup();
    expect(socket().url.href).toBe(`ws://localhost:5173/api/canvases/${ids.canvas}/live`);
    act(() => result.current.sendSelection({ kind: "node", id: ids.service }));
    expect(socket().sent).toEqual([]);

    socket().open();
    expect(result.current.connected).toBe(true);
    expect(socket().sent).toEqual([{ type: "selection", kind: "node", id: ids.service }]);
    expect(invalidatedKeys()).toContainEqual(["canvas-graph", ids.canvas]);
  });

  it("tracks peers through presence, join, cursor, selection, activity, and leave messages", () => {
    const { result, socket } = setup();
    socket().open();
    socket().receive({
      type: "presence",
      peers: [
        { id: "peer-1", name: "Grace", colorIndex: 2, cursor: { x: 1, y: 2 }, selection: { kind: "node", id: "n1" } },
        { id: 7, name: "Invalid" },
        null,
      ],
    });
    expect(result.current.peers).toEqual([
      expect.objectContaining({
        id: "peer-1",
        name: "Grace",
        colorIndex: 2,
        cursor: { x: 1, y: 2 },
        selection: { kind: "node", id: "n1" },
      }),
    ]);

    socket().receive({ type: "joined", id: "peer-2", name: "Linus" });
    expect(result.current.peers.map((peer) => peer.id)).toEqual(["peer-1", "peer-2"]);
    expect(result.current.peers[1]).toMatchObject({ colorIndex: 0, cursor: null, selection: null });

    socket().receive({ type: "cursor", id: "peer-2", x: 40, y: 50 });
    socket().receive({ type: "selection", id: "peer-2", selection: { kind: "connection", id: "c1" } });
    socket().receive({ type: "selection", id: "peer-1", selection: { kind: "bogus", id: "x" } });
    socket().receive({ type: "activity", id: "peer-1" });
    expect(result.current.peers).toEqual([
      expect.objectContaining({ id: "peer-1", selection: null }),
      expect.objectContaining({ id: "peer-2", cursor: { x: 40, y: 50 }, selection: { kind: "connection", id: "c1" } }),
    ]);

    socket().receive({ type: "left", id: "peer-1" });
    expect(result.current.peers.map((peer) => peer.id)).toEqual(["peer-2"]);
  });

  it("ignores malformed messages", () => {
    const { result, socket } = setup();
    socket().open();
    socket().receive("{not json");
    socket().receive("null");
    socket().receive({ type: "cursor", x: 1, y: 2 });
    socket().receive({ type: "cursor", id: "ghost", x: "1", y: 2 });
    expect(result.current.peers).toEqual([]);
  });

  it("refreshes canvas data when another participant changes the graph", () => {
    const { socket, invalidatedKeys } = setup();
    socket().open();
    socket().receive({ type: "graph:changed" });
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([["canvases"], ["entity"], ["canvas-activity", ids.canvas]]),
    );
  });

  it("throttles cursor updates and only sends while connected", () => {
    const { result, socket } = setup();
    act(() => result.current.sendCursor(1, 1));
    socket().open();
    socket().sent = [];
    let now = 10_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      result.current.sendCursor(5, 6);
      now += 10;
      result.current.sendCursor(7, 8);
      now += 100;
      result.current.sendCursor(9, 10);
    } finally {
      clock.mockRestore();
    }
    expect(socket().sent).toEqual([
      { type: "cursor", x: 5, y: 6 },
      { type: "cursor", x: 9, y: 10 },
    ]);
  });

  it("reports activity at most every 30 seconds", () => {
    const { socket } = setup();
    socket().open();
    socket().sent = [];
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("keydown"));
    expect(socket().sent).toEqual([{ type: "activity" }]);
  });

  it("reconnects after an unexpected disconnect and clears peers", () => {
    const timers = spyOn(globalThis, "setTimeout");
    const { result, socket } = setup();
    socket().open();
    socket().receive({ type: "joined", id: "peer-1", name: "Grace" });
    socket().drop(1006);
    expect(result.current.connected).toBe(false);
    expect(result.current.peers).toEqual([]);
    const retry = timers.mock.calls.find(([, delay]) => delay === 1000)?.[0] as (() => void) | undefined;
    timers.mockRestore();
    if (!retry) throw new Error("Expected a reconnect to be scheduled after 1 second");
    act(() => retry());
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops reconnecting and rechecks access when the server revokes it", () => {
    const timers = spyOn(globalThis, "setTimeout");
    const { socket, invalidatedKeys } = setup();
    socket().open();
    socket().drop(1008);
    const retries = timers.mock.calls.filter(([, delay]) => delay === 1000);
    timers.mockRestore();
    expect(retries).toEqual([]);
    expect(invalidatedKeys()).toContainEqual(["canvas-access", ids.canvas]);
  });

  it("closes the socket and cancels a pending retry on unmount", () => {
    const { socket, unmount } = setup();
    const first = socket();
    first.drop(1006);
    const clear = spyOn(globalThis, "clearTimeout");
    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
