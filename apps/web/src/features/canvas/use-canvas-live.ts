import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export type LiveSelection = { kind: "node" | "connection"; id: string } | null;
export interface LivePeer {
  id: string;
  name: string;
  colorIndex: number;
  cursor: { x: number; y: number } | null;
  selection: LiveSelection;
  lastActiveAt: number;
}

const API_URL = import.meta.env.VITE_API_URL ?? "";

function parsePeer(value: unknown): LivePeer | null {
  if (!value || typeof value !== "object") return null;
  const peer = value as Partial<LivePeer>;
  if (typeof peer.id !== "string" || typeof peer.name !== "string") return null;
  const cursor =
    peer.cursor && typeof peer.cursor.x === "number" && typeof peer.cursor.y === "number" ? peer.cursor : null;
  const selection =
    peer.selection &&
    (peer.selection.kind === "node" || peer.selection.kind === "connection") &&
    typeof peer.selection.id === "string"
      ? peer.selection
      : null;
  return {
    id: peer.id,
    name: peer.name,
    colorIndex: typeof peer.colorIndex === "number" ? peer.colorIndex : 0,
    cursor,
    selection,
    lastActiveAt: typeof peer.lastActiveAt === "number" ? peer.lastActiveAt : Date.now(),
  };
}

export function useCanvasLive(canvasId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const lastCursorAt = useRef(0);
  const selectionRef = useRef<LiveSelection>(null);
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let lastActivityAt = 0;
    const sendActivity = () => {
      if (Date.now() - lastActivityAt < 30_000) return;
      lastActivityAt = Date.now();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "activity" }));
    };
    const connect = () => {
      const url = new URL(`${API_URL}/api/canvases/${canvasId}/live`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        const selection = selectionRef.current;
        socket?.send(JSON.stringify({ type: "selection", kind: selection?.kind ?? null, id: selection?.id ?? null }));
        void queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
      };
      socket.onmessage = (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        if (message.type === "graph:changed") {
          void queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
          void queryClient.invalidateQueries({ queryKey: ["canvases"] });
          void queryClient.invalidateQueries({ queryKey: ["entity"] });
          void queryClient.invalidateQueries({ queryKey: ["canvas-activity", canvasId] });
          return;
        }
        if (message.type === "presence" && Array.isArray(message.peers)) {
          setPeers(message.peers.map(parsePeer).filter((peer): peer is LivePeer => peer !== null));
          return;
        }
        if (message.type === "joined") {
          const peer = parsePeer({ ...message, cursor: null, selection: null });
          if (peer) setPeers((current) => [...current.filter((item) => item.id !== peer.id), peer]);
          return;
        }
        if (message.type === "left") {
          setPeers((current) => current.filter((peer) => peer.id !== message.id));
          return;
        }
        if (typeof message.id !== "string") return;
        if (message.type === "cursor" && typeof message.x === "number" && typeof message.y === "number") {
          setPeers((current) =>
            current.map((peer) =>
              peer.id === message.id
                ? { ...peer, cursor: { x: message.x as number, y: message.y as number }, lastActiveAt: Date.now() }
                : peer,
            ),
          );
        } else if (message.type === "selection") {
          setPeers((current) =>
            current.map((peer) =>
              peer.id === message.id
                ? {
                    ...peer,
                    selection:
                      parsePeer({ id: peer.id, name: peer.name, selection: message.selection })?.selection ?? null,
                    lastActiveAt: Date.now(),
                  }
                : peer,
            ),
          );
        } else if (message.type === "activity") {
          setPeers((current) =>
            current.map((peer) => (peer.id === message.id ? { ...peer, lastActiveAt: Date.now() } : peer)),
          );
        }
      };
      socket.onclose = (event) => {
        setConnected(false);
        if (socketRef.current === socket) socketRef.current = null;
        setPeers([]);
        if (event.code === 1008) void queryClient.invalidateQueries({ queryKey: ["canvas-access", canvasId] });
        if (!stopped && event.code !== 1008) retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15_000));
      };
    };
    connect();
    window.addEventListener("focus", sendActivity);
    window.addEventListener("pointerdown", sendActivity);
    window.addEventListener("keydown", sendActivity);
    return () => {
      stopped = true;
      window.removeEventListener("focus", sendActivity);
      window.removeEventListener("pointerdown", sendActivity);
      window.removeEventListener("keydown", sendActivity);
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socketRef.current = null;
    };
  }, [canvasId, enabled, queryClient]);

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || Date.now() - lastCursorAt.current < 50) return;
    lastCursorAt.current = Date.now();
    socket.send(JSON.stringify({ type: "cursor", x, y }));
  }, []);
  const sendSelection = useCallback((selection: LiveSelection) => {
    selectionRef.current = selection;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "selection", kind: selection?.kind ?? null, id: selection?.id ?? null }));
  }, []);

  return { peers, connected, sendCursor, sendSelection };
}
