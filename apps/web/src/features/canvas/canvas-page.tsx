import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import {
  CircleHelp,
  Hand,
  Focus,
  MousePointer2,
  Plus,
  Workflow,
  Boxes,
  ZoomIn,
  ZoomOut,
  GitBranch,
  LoaderCircle,
  WandSparkles,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { ArchitectureEntity, CanvasNode, ConnectionPath } from "@wooble/domain";
import { AppShell } from "../../components/app-shell";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui";
import { api, ApiError, type CanvasGraph } from "../../lib/api";
import { connectionTitle } from "../../lib/connection-title";
import { useEditorStore } from "../../stores/editor-store";
import { InspectorPanel } from "../inspector/inspector-panel";
import { ContractPreview } from "../inspector/contract-editor";
import type { ArchitectureFlowEdge } from "./architecture-edge";
import { ConnectorEditContext } from "./connector-edit-context";
import { edgeTypes } from "./edge-types";
import { nodeTypes } from "./node-types";
import type { ArchitectureFlowNode } from "./architecture-nodes";
import { buildAutoNeatLayout } from "./auto-neat";
import { CanvasActivityLog } from "./canvas-activity-log";
import { canvasShortcutLabel, resolveCanvasKeyDown, type CanvasTool } from "./canvas-shortcuts";
import { participantColor } from "./participant-color";
import { SystemResizeContext } from "./system-resize-context";
import {
  canResizeSystem,
  resizedSystemPlacements,
  type SystemResizeBounds,
  type SystemResizeSnapshot,
} from "./system-resize";
import "@xyflow/react/dist/style.css";
import { useCanvasLive, type LivePeer, type LiveSelection } from "./use-canvas-live";

const EMPTY_POSITIONS: Record<string, { x: number; y: number }> = {};

interface PendingPlacementSave {
  placement: CanvasNode;
  positionRevision: number;
  requestId: number;
}

export function CanvasPage() {
  const { canvasId } = useParams({ from: "/canvases/$canvasId" });
  const [zenMode, setZenMode] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ id: string; serial: number } | null>(null);
  const graphQuery = useQuery({ queryKey: ["canvas-graph", canvasId], queryFn: () => api.graph(canvasId) });
  const accessQuery = useQuery({ queryKey: ["canvas-access", canvasId], queryFn: () => api.canvasAccess(canvasId) });
  const live = useCanvasLive(canvasId, graphQuery.isSuccess && accessQuery.isSuccess);
  const systems = graphQuery.data?.entities.filter((entity) => entity.type === "system") ?? [];
  return (
    <AppShell
      canvasName={graphQuery.data?.canvas.name}
      canvasId={canvasId}
      workspaceId={graphQuery.data?.canvas.workspaceId}
      systems={systems}
      canvasGraph={graphQuery.data}
      onFocusEntity={(id) => setFocusRequest({ id, serial: Date.now() })}
      canvasZenMode={zenMode && graphQuery.isSuccess && accessQuery.isSuccess}
    >
      {graphQuery.isPending || accessQuery.isPending ? (
        <CanvasLoading />
      ) : graphQuery.isError || accessQuery.isError ? (
        <CanvasLoadError
          message={(graphQuery.error ?? accessQuery.error)?.message ?? "Access unavailable"}
          onRetry={() => {
            void graphQuery.refetch();
            void accessQuery.refetch();
          }}
        />
      ) : accessQuery.data?.role === "viewer" ? (
        <ReactFlowProvider>
          <CanvasViewer
            canvasId={canvasId}
            graph={graphQuery.data}
            zenMode={zenMode}
            onToggleZenMode={() => setZenMode(!zenMode)}
            live={live}
            focusRequest={focusRequest}
          />
        </ReactFlowProvider>
      ) : (
        <ReactFlowProvider>
          <CanvasEditor
            canvasId={canvasId}
            graph={graphQuery.data}
            zenMode={zenMode}
            onToggleZenMode={() => setZenMode(!zenMode)}
            live={live}
            focusRequest={focusRequest}
          />
        </ReactFlowProvider>
      )}
    </AppShell>
  );
}

const peerColor = (peer: LivePeer) => participantColor(peer.colorIndex);

function decorateEdge(edge: ArchitectureFlowEdge, peers: LivePeer[]): ArchitectureFlowEdge {
  if (!edge.data) return edge;
  return {
    ...edge,
    data: {
      ...edge.data,
      remotePeers: peers
        .filter((peer) => peer.selection?.kind === "connection" && peer.selection.id === edge.id)
        .map((peer) => ({ name: peer.name, color: peerColor(peer) })),
    },
  };
}

function LiveParticipants({ peers, graph, connected }: { peers: LivePeer[]; graph: CanvasGraph; connected: boolean }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const names = new Map<string, string>([
    ...graph.entities.map((item) => [item.id, item.name] as const),
    ...graph.connections.map((item) => [item.id, item.label || item.type] as const),
  ]);
  return (
    <section className="live-participants" aria-label="People on this canvas">
      <span className="live-participants-heading">
        {connected ? `On this canvas · ${peers.length + 1}` : "Connecting to live canvas…"}
      </span>
      <div className="live-participant is-self">
        <span className="live-participant-avatar">{me.data?.name.slice(0, 1).toUpperCase() ?? "Y"}</span>
        <span className="live-participant-copy">
          <strong>{me.data?.name ?? "You"} (you)</strong>
          <small>{connected ? "Online" : "Connecting"}</small>
        </span>
      </div>
      {peers.map((peer) => {
        const afk = now - peer.lastActiveAt > 5 * 60_000;
        return (
          <div
            className={`live-participant ${afk ? "is-afk" : ""}`}
            key={peer.id}
            style={{ "--peer-color": peerColor(peer) } as React.CSSProperties}
          >
            <span className="live-participant-avatar">{peer.name.slice(0, 1).toUpperCase()}</span>
            <span className="live-participant-copy">
              <strong>{peer.name}</strong>
              <small>
                {afk
                  ? "Away"
                  : peer.selection
                    ? `Viewing ${names.get(peer.selection.id) ?? peer.selection.kind}`
                    : "Online"}
              </small>
            </span>
          </div>
        );
      })}
      {connected && !peers.length && <span className="live-participant-empty">Only you are here</span>}
    </section>
  );
}

function LiveCursors({ peers }: { peers: LivePeer[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <ViewportPortal>
      {peers.map((peer) =>
        peer.cursor && now - peer.lastActiveAt < 5 * 60_000 ? (
          <div
            key={peer.id}
            className="live-cursor"
            style={{ left: peer.cursor.x, top: peer.cursor.y, "--peer-color": peerColor(peer) } as React.CSSProperties}
          >
            <MousePointer2 size={19} fill="currentColor" />
            <span>{peer.name}</span>
          </div>
        ) : null,
      )}
    </ViewportPortal>
  );
}

function CanvasViewer({
  canvasId,
  graph,
  zenMode,
  onToggleZenMode,
  live,
  focusRequest,
}: {
  canvasId: string;
  graph: CanvasGraph;
  zenMode: boolean;
  onToggleZenMode: () => void;
  live: ReturnType<typeof useCanvasLive>;
  focusRequest: { id: string; serial: number } | null;
}) {
  const navigate = useNavigate();
  const flow = useReactFlow();
  const [selected, setSelected] = useState<LiveSelection>(null);
  const populatedSystemId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const placement of graph.placements) {
      if (placement.parentEntityId)
        counts.set(placement.parentEntityId, (counts.get(placement.parentEntityId) ?? 0) + 1);
    }
    return graph.entities
      .filter((entity) => entity.type === "system")
      .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]?.id;
  }, [graph.entities, graph.placements]);
  useEffect(() => {
    live.sendSelection(selected);
  }, [live.sendSelection, selected]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (populatedSystemId)
        void flow.fitView({ nodes: [{ id: populatedSystemId }], padding: 0.14, maxZoom: 1.1, duration: 180 });
      else if (graph.placements.length)
        void flow.fitView({ padding: 0.25, minZoom: 0.35, maxZoom: 1.1, duration: 180 });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, populatedSystemId, graph.placements.length]);
  useEffect(() => {
    if (focusRequest)
      void flow.fitView({ nodes: [{ id: focusRequest.id }], padding: 0.2, maxZoom: 1.1, duration: 260 });
  }, [flow, focusRequest]);
  const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const nodes = buildFlowNodes(graph, entityMap, EMPTY_POSITIONS).map((node) => ({
    ...node,
    draggable: false,
    selected: selected?.kind === "node" && selected.id === node.id,
    data: {
      ...node.data,
      remotePeers: live.peers
        .filter((peer) => peer.selection?.kind === "node" && peer.selection.id === node.id)
        .map((peer) => ({ name: peer.name, color: peerColor(peer) })),
    },
  }));
  const edges = buildFlowEdges(graph).map((edge) => ({
    ...decorateEdge(edge, live.peers),
    selected: selected?.kind === "connection" && selected.id === edge.id,
  }));
  const selectedEntity = selected?.kind === "node" ? entityMap.get(selected.id) : undefined;
  const selectedConnection =
    selected?.kind === "connection" ? graph.connections.find((item) => item.id === selected.id) : undefined;
  return (
    <div className="canvas-editor">
      <div className="canvas-workspace">
        <div
          className="flow-surface is-viewer"
          onPointerMove={(event) => {
            const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            live.sendCursor(point.x, point.y);
          }}
        >
          <ReactFlow<ArchitectureFlowNode, ArchitectureFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_event, node) => setSelected({ kind: "node", id: node.id })}
            onEdgeClick={(_event, edge) => setSelected({ kind: "connection", id: edge.id })}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.32 }}
            panOnScroll
            zoomOnScroll
            proOptions={{ hideAttribution: true }}
            // Viewers never delete; keyboard deletion stays editor-only via the confirmed dialog path.
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--canvas-grid)" />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={(node) => minimapColor(node.type)}
              maskColor="var(--minimap-mask)"
              className="architecture-minimap"
            />
            <LiveCursors peers={live.peers} />
          </ReactFlow>
          <LiveParticipants peers={live.peers} graph={graph} connected={live.connected} />
          {!graph.placements.length && <div className="viewer-empty-state">This shared canvas has no nodes yet.</div>}
          <div className="viewer-label">Viewer access · Select a node to open details</div>
          <button type="button" className="viewer-zen-button" onClick={onToggleZenMode} aria-pressed={zenMode}>
            {zenMode ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            {zenMode ? "Exit Zen mode" : "Zen mode"}
          </button>
          <ZoomControls />
        </div>
        {(selectedEntity || selectedConnection) && (
          <aside className="viewer-details" aria-label="Selected item details">
            <button
              type="button"
              className="viewer-details-close"
              aria-label="Close selection"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <span className="eyebrow">{selectedEntity?.type ?? selectedConnection?.type}</span>
            <h2>{selectedEntity?.name ?? (selectedConnection && connectionTitle(selectedConnection))}</h2>
            <p>{selectedEntity?.description ?? selectedConnection?.description ?? "No description yet."}</p>
            {selectedConnection && (
              <ContractPreview value={selectedConnection.metadata.contractBody ?? ""} kind={selectedConnection.type} />
            )}
            {selectedEntity && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/entities/$entityId",
                    params: { entityId: selectedEntity.id },
                    search: { canvasId },
                  })
                }
              >
                Open details
              </Button>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function CanvasEditor({
  canvasId,
  graph,
  zenMode,
  onToggleZenMode,
  live,
  focusRequest,
}: {
  canvasId: string;
  graph: CanvasGraph;
  zenMode: boolean;
  onToggleZenMode: () => void;
  live: ReturnType<typeof useCanvasLive>;
  focusRequest: { id: string; serial: number } | null;
}) {
  const [tool, setTool] = useState<CanvasTool>("select");
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [autoNeatBusy, setAutoNeatBusy] = useState(false);
  const [autoNeatError, setAutoNeatError] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{ serial: number } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailSection, setDetailSection] = useState<"overview" | "documentation" | "schema" | "contract">("overview");
  const [activityOpen, setActivityOpen] = useState(false);
  const queryClient = useQueryClient();
  const [nodes, setNodes, defaultOnNodesChange] = useStateFlowNodes();
  const [edges, setEdges, defaultOnEdgesChange] = useStateFlowEdges(graph);
  const positions = useEditorStore((state) => state.positions[canvasId]) ?? EMPTY_POSITIONS;
  const selectedEntityId = useEditorStore((state) => state.selectedEntityId);
  const selectedConnectionId = useEditorStore((state) => state.selectedConnectionId);
  useEffect(() => {
    live.sendSelection(
      selectedEntityId
        ? { kind: "node", id: selectedEntityId }
        : selectedConnectionId
          ? { kind: "connection", id: selectedConnectionId }
          : null,
    );
  }, [live.sendSelection, selectedEntityId, selectedConnectionId]);
  // The activity sidebar and the inspector are mutually exclusive right-side panels.
  useEffect(() => {
    if (selectedEntityId || selectedConnectionId) setActivityOpen(false);
  }, [selectedEntityId, selectedConnectionId]);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const graphPlacementsRef = useRef(graph.placements);
  graphPlacementsRef.current = graph.placements;
  const setPosition = useEditorStore((state) => state.setPosition);
  const clearPosition = useEditorStore((state) => state.clearPosition);
  const clearPositions = useEditorStore((state) => state.clearPositions);
  const setEntitySelected = useEditorStore((state) => state.setEntitySelected);
  const setConnectionSelected = useEditorStore((state) => state.setConnectionSelected);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const lastRemoteSelection = useRef<{ graph: CanvasGraph; key: string } | null>(null);
  const flow = useReactFlow<ArchitectureFlowNode, ArchitectureFlowEdge>();
  useEffect(() => {
    if (focusRequest)
      void flow.fitView({ nodes: [{ id: focusRequest.id }], padding: 0.2, maxZoom: 1.1, duration: 260 });
  }, [flow, focusRequest]);
  const lastFitCanvasId = useRef<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const bendSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const bendSequence = useRef(0);
  const latestBendRequest = useRef(new Map<string, number>());
  const saveSequence = useRef(0);
  const positionRevisions = useRef(new Map<string, number>());
  const pendingPlacements = useRef(new Map<string, PendingPlacementSave>());
  const resizeSnapshots = useRef(new Map<string, SystemResizeSnapshot>());
  const queuedSaveCount = useRef(0);
  const refreshSaveState = useCallback(() => {
    setSaveState(queuedSaveCount.current > 0 ? "saving" : pendingPlacements.current.size > 0 ? "error" : "saved");
  }, []);

  const saveMutation = useMutation({
    mutationFn: (placements: CanvasNode[]) => api.savePlacements(canvasId, placements),
    onSuccess: async (_result, placements) => {
      queryClient.setQueryData<CanvasGraph>(["canvas-graph", canvasId], (current) => {
        if (!current) return current;
        const placementsByEntityId = new Map(current.placements.map((placement) => [placement.entityId, placement]));
        for (const placement of placements) placementsByEntityId.set(placement.entityId, placement);
        return {
          ...current,
          placements: [...placementsByEntityId.values()],
          canvas: { ...current.canvas, updatedAt: new Date().toISOString() },
        };
      });
      await queryClient.invalidateQueries({ queryKey: ["canvases"] });
    },
  });
  const savePlacements = saveMutation.mutateAsync;

  useEffect(() => {
    const visibleGraph = pendingPlacements.current.size
      ? {
          ...graph,
          placements: graph.placements.map(
            (placement) => pendingPlacements.current.get(placement.entityId)?.placement ?? placement,
          ),
        }
      : graph;
    const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
    setNodes(buildFlowNodes(visibleGraph, entityMap, positionsRef.current));
    setEdges(buildFlowEdges(visibleGraph));
    if (lastFitCanvasId.current !== graph.canvas.id) {
      lastFitCanvasId.current = graph.canvas.id;
      requestAnimationFrame(() => void flow.fitView({ padding: 0.32, minZoom: 0.2, maxZoom: 1.1, duration: 180 }));
    }
  }, [flow, graph, setEdges, setNodes]);

  useEffect(() => {
    const key = live.peers
      .map((peer) => `${peer.id}:${peer.selection?.kind ?? ""}:${peer.selection?.id ?? ""}`)
      .join("|");
    if (lastRemoteSelection.current?.graph === graph && lastRemoteSelection.current.key === key) return;
    lastRemoteSelection.current = { graph, key };
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          remotePeers: live.peers
            .filter((peer) => peer.selection?.kind === "node" && peer.selection.id === node.id)
            .map((peer) => ({ name: peer.name, color: peerColor(peer) })),
        },
      })),
    );
    setEdges((current) => current.map((edge) => decorateEdge(edge, live.peers)));
  }, [graph, live.peers, setNodes, setEdges]);

  // canvasId intentionally resets selection when navigating between canvases.
  // biome-ignore lint/correctness/useExhaustiveDependencies: canvasId is the transition trigger.
  useEffect(() => {
    setEntitySelected(null);
    setConnectionSelected(null);
  }, [canvasId, setConnectionSelected, setEntitySelected]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<ArchitectureFlowNode>[]) => {
      defaultOnNodesChange(
        tool === "hand" ? changes.filter((change) => change.type !== "select" || !change.selected) : changes,
      );
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          positionRevisions.current.set(change.id, (positionRevisions.current.get(change.id) ?? 0) + 1);
          setPosition(canvasId, change.id, change.position);
        }
      }
    },
    [canvasId, defaultOnNodesChange, setPosition, tool],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<ArchitectureFlowEdge>[]) => {
      defaultOnEdgesChange(
        tool === "hand" ? changes.filter((change) => change.type !== "select" || !change.selected) : changes,
      );
    },
    [defaultOnEdgesChange, tool],
  );

  const enqueuePlacementSave = useCallback(
    (placements: CanvasNode | CanvasNode[]) => {
      const batch = Array.isArray(placements) ? placements : [placements];
      const requestId = ++saveSequence.current;
      for (const placement of batch) {
        pendingPlacements.current.set(placement.entityId, {
          placement,
          positionRevision: positionRevisions.current.get(placement.entityId) ?? 0,
          requestId,
        });
      }
      queuedSaveCount.current += 1;
      refreshSaveState();
      const save = async () => {
        try {
          await savePlacements(batch);
          for (const placement of batch) {
            const pending = pendingPlacements.current.get(placement.entityId);
            if (pending?.requestId === requestId) {
              pendingPlacements.current.delete(placement.entityId);
              if (positionRevisions.current.get(placement.entityId) === pending.positionRevision) {
                clearPosition(canvasId, placement.entityId);
              }
            }
          }
        } catch {
          // Keep the latest placement pending so the user can retry it.
        } finally {
          queuedSaveCount.current -= 1;
          refreshSaveState();
        }
      };
      saveQueue.current = saveQueue.current.then(save, save);
    },
    [canvasId, clearPosition, refreshSaveState, savePlacements],
  );

  const retryPendingSaves = useCallback(() => {
    const failedPlacements = [...pendingPlacements.current.values()];
    if (failedPlacements.length) enqueuePlacementSave(failedPlacements.map(({ placement }) => placement));
  }, [enqueuePlacementSave]);

  const startSystemResize = useCallback(
    (id: string) => {
      const liveNodes = flow.getNodes();
      const system = liveNodes.find((node) => node.id === id);
      if (!system) return;
      const [systemPlacement] = flowNodesToPlacements(canvasId, [system], graphPlacementsRef.current);
      if (!systemPlacement) return;
      const children = flowNodesToPlacements(
        canvasId,
        liveNodes.filter((node) => node.parentId === id),
        graphPlacementsRef.current,
      );
      resizeSnapshots.current.set(id, { system: systemPlacement, children });
    },
    [canvasId, flow],
  );
  const canResizeSystemNode = useCallback((id: string, bounds: SystemResizeBounds) => {
    const snapshot = resizeSnapshots.current.get(id);
    return snapshot ? canResizeSystem(snapshot, bounds) : false;
  }, []);
  const finishSystemResize = useCallback(
    (id: string, bounds: SystemResizeBounds) => {
      const snapshot = resizeSnapshots.current.get(id);
      resizeSnapshots.current.delete(id);
      if (!snapshot) return;
      const placements = resizedSystemPlacements(snapshot, bounds);
      const system = placements[0];
      if (
        !system ||
        (system.x === snapshot.system.x &&
          system.y === snapshot.system.y &&
          system.width === snapshot.system.width &&
          system.height === snapshot.system.height)
      )
        return;
      for (const placement of placements) {
        positionRevisions.current.set(placement.entityId, (positionRevisions.current.get(placement.entityId) ?? 0) + 1);
        setPosition(canvasId, placement.entityId, { x: placement.x, y: placement.y });
      }
      enqueuePlacementSave(placements);
    },
    [canvasId, enqueuePlacementSave, setPosition],
  );
  const resizeControls = useMemo(
    () => ({
      enabled: tool === "select" && !autoNeatBusy && !creating,
      canResize: canResizeSystemNode,
      onStart: startSystemResize,
      onEnd: finishSystemResize,
    }),
    [autoNeatBusy, canResizeSystemNode, creating, finishSystemResize, startSystemResize, tool],
  );

  const selectNode = useCallback<NodeMouseHandler<ArchitectureFlowNode>>(
    async (_event, node) => {
      if (autoNeatBusy || tool === "hand" || tool === "edit-connector") return;
      if (tool !== "connector") {
        setEntitySelected(node.id);
        return;
      }
      if (!connectionSource) {
        setConnectionSource(node.id);
        return;
      }
      if (connectionSource === node.id) return;
      setCreating(true);
      setCreationError(null);
      try {
        const created = await api.createCanvasConnection(canvasId, {
          sourceEntityId: connectionSource,
          targetEntityId: node.id,
          type: "rest",
        });
        await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
        setConnectionSelected(created.id);
        setConnectionSource(null);
        setTool("select");
      } catch (error) {
        setCreationError(error instanceof Error ? error.message : "Could not create connection");
      } finally {
        setCreating(false);
      }
    },
    [autoNeatBusy, canvasId, connectionSource, queryClient, setConnectionSelected, setEntitySelected, tool],
  );
  const selectEdge = useCallback<EdgeMouseHandler<ArchitectureFlowEdge>>(
    (_event, edge) => {
      if (tool === "select" || tool === "edit-connector") setConnectionSelected(edge.id);
    },
    [setConnectionSelected, tool],
  );
  const clearSelection = useCallback(() => {
    setEntitySelected(null);
    setConnectionSelected(null);
    setNodes((current) => current.map((node) => (node.selected ? { ...node, selected: false } : node)));
    setEdges((current) => current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)));
    setDetailsOpen(false);
  }, [setConnectionSelected, setEdges, setEntitySelected, setNodes]);

  const handleActivityOpenChange = useCallback(
    (open: boolean) => {
      setActivityOpen(open);
      // Opening the activity sidebar closes the inspector; both live on the right.
      if (open) clearSelection();
    },
    [clearSelection],
  );

  const runUndo = useCallback(() => {
    if (autoNeatBusy || creating) return;
    void (async () => {
      setUndoError(null);
      setUndoNotice(null);
      try {
        await Promise.all([saveQueue.current, bendSaveQueue.current]);
      } catch {
        // Undo targets persisted events; keep going even if a pending save promise rejected.
      }
      try {
        const result = await api.undoCanvas(canvasId);
        if (!result.undone) return;
        if (result.skipped?.length) setUndoNotice(describeSkippedEvents(result.skipped));
        clearPositions(canvasId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] }),
          queryClient.invalidateQueries({ queryKey: ["canvas-activity", canvasId] }),
          queryClient.invalidateQueries({ queryKey: ["entity"] }),
          queryClient.invalidateQueries({ queryKey: ["canvases"] }),
        ]);
      } catch (error) {
        setUndoError(
          error instanceof ApiError ? error.message : "Could not undo the last change. Check your connection.",
        );
      }
    })();
  }, [autoNeatBusy, canvasId, clearPositions, creating, queryClient]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inInteractiveTarget = Boolean(
        target instanceof Element &&
          target.closest("[role='dialog'], input, textarea, select, [contenteditable='true']"),
      );
      const action = resolveCanvasKeyDown(event, {
        busy: autoNeatBusy || creating,
        detailsOpen,
        selection: selectedEntityId ? "entity" : selectedConnectionId ? "connection" : null,
        inInteractiveTarget,
        onConnectorBendHandle: Boolean(target instanceof Element && target.closest(".connector-bend-handle")),
      });
      if (action.kind === "none") return;
      event.preventDefault();
      if (action.kind === "tool") {
        if (action.tool === "hand") clearSelection();
        setTool(action.tool);
        setConnectionSource(null);
        return;
      }
      if (action.kind === "undo") {
        runUndo();
        return;
      }
      if (action.kind === "request-delete") setDeleteRequest({ serial: Date.now() });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [autoNeatBusy, clearSelection, creating, detailsOpen, runUndo, selectedConnectionId, selectedEntityId]);

  const saveBend = useCallback(
    (connectionId: string, bend: ConnectionPath) => {
      if (autoNeatBusy) return Promise.resolve();
      const requestId = ++bendSequence.current;
      latestBendRequest.current.set(connectionId, requestId);
      setCreationError(null);
      const save = async () => {
        try {
          await api.saveConnectionBend(canvasId, connectionId, bend);
          if (latestBendRequest.current.get(connectionId) === requestId)
            await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
        } catch (error) {
          if (latestBendRequest.current.get(connectionId) === requestId)
            setCreationError(error instanceof Error ? error.message : "Could not save connector path");
        }
      };
      bendSaveQueue.current = bendSaveQueue.current.then(save, save);
      return bendSaveQueue.current;
    },
    [autoNeatBusy, canvasId, queryClient],
  );

  const runAutoNeat = useCallback(async () => {
    if (autoNeatBusy || creating) return;
    setAutoNeatBusy(true);
    setAutoNeatError(null);
    try {
      await Promise.all([saveQueue.current, bendSaveQueue.current]);
      if (pendingPlacements.current.size > 0) throw new Error("Retry the failed save before using Auto Neat.");
      const latestGraph = await api.graph(canvasId);
      const layout = buildAutoNeatLayout(latestGraph);
      await api.autoNeatCanvas(canvasId, { expectedUpdatedAt: latestGraph.canvas.updatedAt, ...layout });
      for (const placement of layout.placements) clearPosition(canvasId, placement.entityId);
      await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
      await queryClient.invalidateQueries({ queryKey: ["canvases"] });
      requestAnimationFrame(() => void flow.fitView({ padding: 0.32, duration: 280 }));
    } catch (error) {
      setAutoNeatError(error instanceof Error ? error.message : "Could not tidy the canvas");
    } finally {
      setAutoNeatBusy(false);
    }
  }, [autoNeatBusy, canvasId, clearPosition, creating, flow, queryClient]);

  const onNodeDragStop = useCallback<OnNodeDrag<ArchitectureFlowNode>>(
    (_event, node) => {
      if (autoNeatBusy) return;
      const [placement] = flowNodesToPlacements(canvasId, [node], graph.placements);
      if (placement) {
        const absolute = absoluteNodePosition(node, nodes);
        const parent = containingSystem(nodes, absolute, placement.width, placement.height, node.id);
        placement.parentEntityId = parent?.id ?? null;
        const parentPosition = parent ? absoluteNodePosition(parent, nodes) : { x: 0, y: 0 };
        placement.x = Math.round(absolute.x - parentPosition.x);
        placement.y = Math.round(absolute.y - parentPosition.y);
        if ((node.parentId ?? null) !== placement.parentEntityId) {
          setNodes((current) =>
            orderFlowNodes(
              current.map((item) =>
                item.id === node.id
                  ? { ...item, parentId: parent?.id, position: { x: placement.x, y: placement.y } }
                  : item,
              ),
            ),
          );
        }
      }
      if (placement) enqueuePlacementSave(placement);
    },
    [autoNeatBusy, canvasId, enqueuePlacementSave, graph.placements, nodes, setNodes],
  );

  const placeEntity = useCallback(
    async (event: React.MouseEvent) => {
      if (creating || autoNeatBusy || (tool !== "node" && tool !== "system")) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const type = tool === "system" ? "system" : "service";
      const parent = containingSystem(nodes, point, type === "system" ? 300 : 220, type === "system" ? 220 : 120);
      const parentPosition = parent ? absoluteNodePosition(parent, nodes) : { x: 0, y: 0 };
      setCreating(true);
      setCreationError(null);
      try {
        const created = await api.createCanvasEntity(canvasId, {
          type,
          name: "",
          x: Math.round(point.x - parentPosition.x),
          y: Math.round(point.y - parentPosition.y),
          parentEntityId: parent?.id ?? null,
        });
        await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
        setEntitySelected(created.id);
        setTool("select");
      } catch (error) {
        setCreationError(error instanceof Error ? error.message : "Could not create node");
      } finally {
        setCreating(false);
      }
    },
    [autoNeatBusy, canvasId, creating, flow, nodes, queryClient, setEntitySelected, tool],
  );

  return (
    <div className="canvas-editor">
      <div className="canvas-workspace">
        <div
          className={`flow-surface tool-${tool}`}
          onPointerMove={(event) => {
            const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            live.sendCursor(point.x, point.y);
          }}
        >
          <SystemResizeContext.Provider value={resizeControls}>
            <ConnectorEditContext.Provider value={{ editing: tool === "edit-connector", saveBend }}>
              <ReactFlow<ArchitectureFlowNode, ArchitectureFlowEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onNodeClick={(event, node) => {
                  if ((tool === "node" || tool === "system") && node.type === "system") void placeEntity(event);
                  else void selectNode(event, node);
                }}
                onEdgeClick={selectEdge}
                onPaneClick={(event) => {
                  setActivityOpen(false);
                  if (tool === "node" || tool === "system") void placeEntity(event);
                  else if (tool === "select") clearSelection();
                }}
                onNodeDragStop={onNodeDragStop}
                fitView
                fitViewOptions={{ padding: 0.32, minZoom: 0.2, maxZoom: 1.1 }}
                minZoom={0.18}
                maxZoom={1.8}
                nodesConnectable={false}
                nodesDraggable={tool === "select" && !autoNeatBusy}
                elementsSelectable={
                  !autoNeatBusy && (tool === "select" || tool === "connector" || tool === "edit-connector")
                }
                panOnDrag={autoNeatBusy ? false : tool === "hand" ? [0, 1] : [1]}
                panOnScroll
                selectionOnDrag={false}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ deletable: false }}
                // Keyboard deletion goes through the confirmed canvas API dialog, not React Flow's local removal.
                deleteKeyCode={null}
              >
                <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--canvas-grid)" />
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  nodeColor={(node) => minimapColor(node.type)}
                  maskColor="var(--minimap-mask)"
                  className="architecture-minimap"
                />
                <LiveCursors peers={live.peers} />
              </ReactFlow>
              <LiveParticipants peers={live.peers} graph={graph} connected={live.connected} />
            </ConnectorEditContext.Provider>
          </SystemResizeContext.Provider>
          <TooltipProvider delayDuration={180}>
            <div className="canvas-toolbox" role="toolbar" aria-label="Canvas tools">
              <ToolButton
                label="Select"
                shortcut={canvasShortcutLabel("select")}
                pressed={tool === "select"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  setTool("select");
                  setConnectionSource(null);
                }}
              >
                <MousePointer2 size={18} />
              </ToolButton>
              <ToolButton
                label="Hand"
                shortcut={canvasShortcutLabel("hand")}
                pressed={tool === "hand"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  clearSelection();
                  setTool("hand");
                  setConnectionSource(null);
                }}
              >
                <Hand size={18} />
              </ToolButton>
              <span className="toolbox-divider" />
              <ToolButton
                label="Add node"
                shortcut={canvasShortcutLabel("node")}
                pressed={tool === "node"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  setTool("node");
                  setConnectionSource(null);
                }}
              >
                <Plus size={18} />
              </ToolButton>
              <ToolButton
                label="Connector"
                shortcut={canvasShortcutLabel("connector")}
                pressed={tool === "connector"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  setTool("connector");
                  setConnectionSource(null);
                }}
              >
                <Workflow size={18} />
              </ToolButton>
              <ToolButton
                label="System box"
                shortcut={canvasShortcutLabel("system")}
                pressed={tool === "system"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  setTool("system");
                  setConnectionSource(null);
                }}
              >
                <Boxes size={18} />
              </ToolButton>
              <span className="toolbox-divider" />
              <ToolButton
                label="Edit connector"
                shortcut={canvasShortcutLabel("edit-connector")}
                pressed={tool === "edit-connector"}
                disabled={creating || autoNeatBusy}
                onClick={() => {
                  setTool("edit-connector");
                  setConnectionSource(null);
                }}
              >
                <GitBranch size={18} />
              </ToolButton>
              <ToolButton label="Auto Neat" onClick={() => void runAutoNeat()} disabled={autoNeatBusy || creating}>
                {autoNeatBusy ? <LoaderCircle size={18} className="auto-neat-spinner" /> : <WandSparkles size={18} />}
              </ToolButton>
              <span className="toolbox-divider" />
              <ToolButton label={zenMode ? "Exit Zen mode" : "Zen mode"} pressed={zenMode} onClick={onToggleZenMode}>
                {zenMode ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </ToolButton>
            </div>
            <ZoomControls />
            <CanvasActivityLog canvasId={canvasId} open={activityOpen} onOpenChange={handleActivityOpenChange} />
          </TooltipProvider>
          {(autoNeatBusy || autoNeatError) && (
            <div className="canvas-auto-neat-status" role="status">
              {autoNeatBusy ? (
                <>
                  <LoaderCircle size={14} className="auto-neat-spinner" /> Tidying canvas…
                </>
              ) : (
                <span className="tool-error">{autoNeatError}</span>
              )}
            </div>
          )}
          {(tool === "node" || tool === "system" || tool === "connector" || tool === "edit-connector") && (
            <div className="canvas-tool-options">
              <span>
                {tool === "edit-connector"
                  ? selectedConnectionId
                    ? "Double-click a line to add a point · Drag points to reroute · Double-click a point to remove"
                    : "Click a connector, then double-click its line to add a point"
                  : tool === "connector"
                    ? connectionSource
                      ? "Click the target node"
                      : "Click the source node"
                    : tool === "system"
                      ? "Click the canvas to place a system box"
                      : "Click the canvas to place a node"}
              </span>
              {tool === "edit-connector" &&
                selectedConnectionId &&
                graph.connections.find((connection) => connection.id === selectedConnectionId)?.bend && (
                  <button type="button" onClick={() => void saveBend(selectedConnectionId, null)}>
                    Reset path
                  </button>
                )}
              {creationError && (
                <span className="tool-error" role="alert">
                  {creationError}
                </span>
              )}
            </div>
          )}
          {saveState === "error" && (
            <div className="canvas-save-indicator save-error">
              <CircleHelp size={13} /> Save failed{" "}
              <button type="button" onClick={retryPendingSaves}>
                Retry
              </button>
            </div>
          )}
          {undoError && (
            <div className="canvas-save-indicator save-error" role="alert">
              <CircleHelp size={13} /> {undoError}
            </div>
          )}
          {undoNotice && (
            <div className="canvas-save-indicator" role="status">
              <CircleHelp size={13} /> {undoNotice}
            </div>
          )}
        </div>
        {(selectedEntityId || selectedConnectionId) && (
          <InspectorPanel
            key={`sidebar-${selectedEntityId ?? selectedConnectionId}`}
            graph={graph}
            canvasId={canvasId}
            deleteRequest={deleteRequest}
            onOpenDetails={(section) => {
              setDetailSection(section);
              setDetailsOpen(true);
            }}
          />
        )}
      </div>
      <Dialog open={detailsOpen && Boolean(selectedEntityId || selectedConnectionId)} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="canvas-details-dialog"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (
              document.activeElement instanceof Element &&
              document.activeElement.hasAttribute("data-inline-editing")
            ) {
              event.preventDefault();
            }
          }}
        >
          <DialogTitle className="sr-only">Canvas details</DialogTitle>
          {(selectedEntityId || selectedConnectionId) && (
            <InspectorPanel
              key={`details-${selectedEntityId ?? selectedConnectionId}`}
              graph={graph}
              canvasId={canvasId}
              mode="details"
              detailSection={detailSection}
              onSelectDetailSection={setDetailSection}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Visible platform shortcut hint, or undefined for actions without a keyboard shortcut. */
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {shortcut && <span className="toolbox-shortcut">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow<ArchitectureFlowNode, ArchitectureFlowEdge>();
  return (
    <div className="canvas-zoom-tools" role="toolbar" aria-label="Zoom controls">
      <ToolButton label="Zoom out" onClick={() => void zoomOut({ duration: 180 })}>
        <ZoomOut size={18} />
      </ToolButton>
      <ToolButton label="Zoom in" onClick={() => void zoomIn({ duration: 180 })}>
        <ZoomIn size={18} />
      </ToolButton>
      <span className="toolbox-divider" />
      <ToolButton label="Fit canvas" onClick={() => void fitView({ padding: 0.22, duration: 280 })}>
        <Focus size={18} />
      </ToolButton>
    </div>
  );
}

function useStateFlowNodes(): [
  ArchitectureFlowNode[],
  Dispatch<SetStateAction<ArchitectureFlowNode[]>>,
  (changes: NodeChange<ArchitectureFlowNode>[]) => void,
] {
  const [nodes, setNodes] = useState<ArchitectureFlowNode[]>([]);
  const onNodesChange = useCallback(
    (changes: NodeChange<ArchitectureFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  return [nodes, setNodes, onNodesChange];
}

function useStateFlowEdges(
  graph: CanvasGraph,
): [
  ArchitectureFlowEdge[],
  Dispatch<SetStateAction<ArchitectureFlowEdge[]>>,
  (changes: EdgeChange<ArchitectureFlowEdge>[]) => void,
] {
  const [edges, setEdges] = useState<ArchitectureFlowEdge[]>(() => buildFlowEdges(graph));
  const onEdgesChange = useCallback(
    (changes: EdgeChange<ArchitectureFlowEdge>[]) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );
  return [edges, setEdges, onEdgesChange];
}

function buildFlowNodes(
  graph: CanvasGraph,
  entities: Map<string, ArchitectureEntity>,
  positions: Record<string, { x: number; y: number }>,
): ArchitectureFlowNode[] {
  const children = new Map<string, number>();
  graph.placements.forEach((placement) => {
    if (placement.parentEntityId)
      children.set(placement.parentEntityId, (children.get(placement.parentEntityId) ?? 0) + 1);
  });
  const placementByEntityId = new Map(graph.placements.map((placement) => [placement.entityId, placement]));
  const depthByEntityId = new Map<string, number>();
  const getDepth = (entityId: string, visiting = new Set<string>()): number => {
    const cached = depthByEntityId.get(entityId);
    if (cached !== undefined) return cached;
    const placement = placementByEntityId.get(entityId);
    if (!placement?.parentEntityId || visiting.has(entityId) || !placementByEntityId.has(placement.parentEntityId))
      return 0;
    visiting.add(entityId);
    const depth = getDepth(placement.parentEntityId, visiting) + 1;
    visiting.delete(entityId);
    depthByEntityId.set(entityId, depth);
    return depth;
  };
  const placements = [...graph.placements].sort((a, b) => getDepth(a.entityId) - getDepth(b.entityId));
  return placements.flatMap((placement) => {
    const entity = entities.get(placement.entityId);
    if (!entity) return [];
    const nodeType = entity.type;
    const databaseNames = graph.connections
      .filter(
        (connection) =>
          connection.type === "database" &&
          (connection.sourceEntityId === entity.id || connection.targetEntityId === entity.id),
      )
      .map((connection) =>
        entities.get(connection.sourceEntityId === entity.id ? connection.targetEntityId : connection.sourceEntityId),
      )
      .filter((related): related is ArchitectureEntity => related?.type === "database")
      .map((database) => database.metadata.engine ?? database.name);
    const interfaces = entity.metadata.interfaces ?? [];
    const subtitle = entity.type === "service" ? [...interfaces, ...databaseNames].join(" · ") : undefined;
    return [
      {
        id: entity.id,
        type: nodeType,
        position: positions[entity.id] ?? { x: placement.x, y: placement.y },
        parentId: placement.parentEntityId ?? undefined,
        data: { entity, childCount: children.get(entity.id) ?? 0, subtitle },
        style: { width: placement.width, height: placement.height, zIndex: entity.type === "system" ? 0 : 2 },
        ...(entity.type === "system" ? { zIndex: 0 } : { zIndex: 3 }),
      } as ArchitectureFlowNode,
    ];
  });
}

function buildFlowEdges(graph: CanvasGraph): ArchitectureFlowEdge[] {
  const placements = new Map(graph.placements.map((placement) => [placement.entityId, placement]));
  const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const lanes = new Map<string, number>();
  return [...graph.connections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((connection) => {
      const source = placements.get(connection.sourceEntityId);
      const target = placements.get(connection.targetEntityId);
      if (!source || !target) return [];
      const sourceParent = source.parentEntityId ? placements.get(source.parentEntityId) : undefined;
      const targetParent = target.parentEntityId ? placements.get(target.parentEntityId) : undefined;
      const sourceX = source.x + (sourceParent?.x ?? 0) + source.width / 2;
      const sourceY = source.y + (sourceParent?.y ?? 0) + source.height / 2;
      const targetX = target.x + (targetParent?.x ?? 0) + target.width / 2;
      const targetY = target.y + (targetParent?.y ?? 0) + target.height / 2;
      const dx = targetX - sourceX;
      const dy = targetY - sourceY;
      const sourceSide = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
      const targetSide = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "left" : "right") : dy > 0 ? "top" : "bottom";
      const laneKey = `${connection.sourceEntityId}:${sourceSide}`;
      const lane = lanes.get(laneKey) ?? 0;
      lanes.set(laneKey, lane + 1);
      return [
        {
          id: connection.id,
          source: connection.sourceEntityId,
          target: connection.targetEntityId,
          sourceHandle: `source-${sourceSide}`,
          targetHandle: `target-${targetSide}`,
          type: "architecture",
          data: { connection, lane },
          label: connection.label,
          deletable: false,
        } as ArchitectureFlowEdge,
      ];
    })
    .filter((edge) => entityMap.has(edge.source) && entityMap.has(edge.target));
}

function flowNodesToPlacements(canvasId: string, nodes: ArchitectureFlowNode[], existing: CanvasNode[]): CanvasNode[] {
  const existingById = new Map(existing.map((placement) => [placement.entityId, placement]));
  return nodes.map((node) => {
    const old = existingById.get(node.id);
    return {
      canvasId,
      entityId: node.id,
      parentEntityId: node.parentId ?? null,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      width: Math.round(numberFromStyle(node.style?.width, old?.width ?? 220)),
      height: Math.round(numberFromStyle(node.style?.height, old?.height ?? 120)),
    };
  });
}

function absoluteNodePosition(node: ArchitectureFlowNode, nodes: ArchitectureFlowNode[]) {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set([node.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((item) => item.id === parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function hasAncestor(node: ArchitectureFlowNode, ancestorId: string, nodes: ArchitectureFlowNode[]) {
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = nodes.find((item) => item.id === parentId)?.parentId;
  }
  return false;
}

function containingSystem(
  nodes: ArchitectureFlowNode[],
  point: { x: number; y: number },
  width: number,
  height: number,
  movingId?: string,
) {
  return nodes
    .filter((node) => {
      if (node.type !== "system" || node.id === movingId || (movingId && hasAncestor(node, movingId, nodes)))
        return false;
      const position = absoluteNodePosition(node, nodes);
      return (
        point.x >= position.x &&
        point.y >= position.y &&
        point.x + width <= position.x + numberFromStyle(node.style?.width, 440) &&
        point.y + height <= position.y + numberFromStyle(node.style?.height, 360)
      );
    })
    .sort(
      (a, b) =>
        numberFromStyle(a.style?.width, 440) * numberFromStyle(a.style?.height, 360) -
        numberFromStyle(b.style?.width, 440) * numberFromStyle(b.style?.height, 360),
    )[0];
}

function orderFlowNodes(nodes: ArchitectureFlowNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: ArchitectureFlowNode) => {
    let level = 0;
    let parentId = node.parentId;
    const visited = new Set([node.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      level += 1;
      parentId = parent.parentId;
    }
    return level;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

function numberFromStyle(value: string | number | undefined, fallback: number) {
  return typeof value === "number" ? value : value ? Number.parseFloat(value) || fallback : fallback;
}
function minimapColor(type: string | undefined) {
  if (type === "system") return "#DDD6C8";
  if (type === "database") return "#6B7F6E";
  if (type === "frontend" || type === "device" || type === "gateway") return "#C9A892";
  return "#6B7280";
}
const UNDO_ACTION_LABELS: Record<string, string> = {
  "entity.created": "Created",
  "entity.updated": "Edited",
  "entity.deleted": "Deleted",
  "connection.created": "Added connector",
  "connection.updated": "Edited connector",
  "connection.deleted": "Removed connector",
  "placement.updated": "Moved",
  "canvas.auto_neat": "Auto Neat on",
  "canvas.updated": "Updated",
};
interface UndoSkippedEntry {
  action: string;
  targetName: string | null;
  reason?: "conflict" | "no-op";
}
function describeSkippedEvent(event: UndoSkippedEntry) {
  const label = UNDO_ACTION_LABELS[event.action] ?? event.action;
  return event.targetName ? `${label} "${event.targetName}"` : label;
}
function describeSkippedEvents(events: UndoSkippedEntry[]) {
  const conflicts = events.filter((event) => event.reason !== "no-op");
  const noOps = events.filter((event) => event.reason === "no-op");
  const parts: string[] = [];
  if (conflicts.length) {
    const count = conflicts.length === 1 ? "1 change" : `${conflicts.length} changes`;
    parts.push(`Skipped ${count} a collaborator changed first: ${conflicts.map(describeSkippedEvent).join(", ")}.`);
  }
  if (noOps.length) {
    const count = noOps.length === 1 ? "1 earlier change" : `${noOps.length} earlier changes`;
    parts.push(`${count} no longer had any visible effect.`);
  }
  return parts.join(" ");
}
function CanvasLoading() {
  return (
    <div className="canvas-load-state">
      <div className="canvas-load-spinner" />
      <span>Opening architecture canvas…</span>
    </div>
  );
}
function CanvasLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="canvas-load-state error">
      <h2>This canvas could not be opened</h2>
      <p>{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
