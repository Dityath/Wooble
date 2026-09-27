import { useContext, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { ArchitectureConnection, ConnectionBend, ConnectionPath } from "@wooble/domain";
import { useEditorStore } from "../../stores/editor-store";
import { connectionTitle } from "../../lib/connection-title";
import { ConnectorEditContext } from "./connector-edit-context";
import { buildConnectorRoute, closestRouteInsertion, isHorizontalRoute, routeWaypoints } from "./connector-route";

export type ArchitectureFlowEdge = Edge<{
  connection: ArchitectureConnection & { bend: ConnectionPath };
  lane?: number;
  remotePeers?: { name: string; color: string }[];
}>;

export function ArchitectureEdge(props: EdgeProps<ArchitectureFlowEdge>) {
  const { editing, saveBend } = useContext(ConnectorEditContext);
  const flow = useReactFlow();
  const setConnectionSelected = useEditorStore((state) => state.setConnectionSelected);
  const selectedConnectionId = useEditorStore((state) => state.selectedConnectionId);
  const [draftWaypoints, setDraftWaypoints] = useState<ConnectionBend[] | null>(null);
  const draggingIndex = useRef<number | null>(null);
  const dragRevision = useRef(0);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 10,
    offset: 22 + (props.data?.lane ?? 0) * 22,
  });
  const type = props.data?.connection.type ?? "rest";
  const label = props.data?.connection ? connectionTitle(props.data.connection) : "Connection";
  const waypoints = draftWaypoints ?? routeWaypoints(props.data?.connection.bend ?? null);
  const horizontal = isHorizontalRoute(
    props.sourceHandleId,
    { x: props.sourceX, y: props.sourceY },
    { x: props.targetX, y: props.targetY },
  );
  const route = buildConnectorRoute(
    { x: props.sourceX, y: props.sourceY },
    { x: props.targetX, y: props.targetY },
    waypoints,
    horizontal,
  );
  const path = waypoints.length ? route.path : edgePath;
  const labelPosition = waypoints.length ? route.label : { x: labelX, y: labelY };
  const active = selectedConnectionId === props.id;
  const remotePeer = props.data?.remotePeers?.[0];
  const persistWaypoints = (next: ConnectionBend[]) => {
    const revision = ++dragRevision.current;
    setDraftWaypoints(next);
    void saveBend(props.id, next.length ? next : null).finally(() => {
      if (dragRevision.current === revision) setDraftWaypoints(null);
    });
  };
  const addWaypoint = (point: ConnectionBend) => {
    if (!editing || !active || waypoints.length >= 12) return;
    const index = closestRouteInsertion(route.segments, point);
    const next = [...waypoints];
    next.splice(index, 0, point);
    persistWaypoints(next);
  };
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          stroke: remotePeer?.color ?? (active || props.selected ? "#6B7F6E" : edgeColor(type)),
          strokeWidth: remotePeer || active || props.selected ? 2.8 : 1.7,
          strokeDasharray: type === "database" ? "5 4" : undefined,
          transition: "stroke .15s",
        }}
      />
      {/* SVG path preserves the connector-shaped hit area and supports keyboard activation. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a native button cannot follow the connector path. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        className="architecture-edge-hitbox"
        role="button"
        aria-label="Add connector point"
        tabIndex={editing && active ? 0 : -1}
        onDoubleClick={(event) => {
          if (!editing || !active || waypoints.length >= 12) return;
          event.preventDefault();
          event.stopPropagation();
          const flowPoint = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          addWaypoint({ x: Math.round(flowPoint.x), y: Math.round(flowPoint.y) });
        }}
        onKeyDown={(event) => {
          if (!editing || !active || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.stopPropagation();
          addWaypoint({ x: Math.round(route.label.x), y: Math.round(route.label.y) });
        }}
      />
      <EdgeLabelRenderer>
        {remotePeer && (
          <div
            className="remote-edge-selection"
            style={
              {
                transform: `translate(-50%, -100%) translate(${labelPosition.x}px,${labelPosition.y - 12}px)`,
                "--peer-color": remotePeer.color,
              } as React.CSSProperties
            }
          >
            {remotePeer.name} selected
          </div>
        )}
        {editing &&
          active &&
          waypoints.map((point, index) => (
            <button
              // Index identifies the ordered route slot; coordinates change throughout a drag.
              // biome-ignore lint/suspicious/noArrayIndexKey: route points have no persisted IDs.
              key={`${props.id}-waypoint-${index}`}
              type="button"
              className="connector-bend-handle nodrag nopan"
              aria-label={`Connector point ${index + 1}; drag to move or double-click to remove`}
              title="Drag to move · Double-click to remove"
              style={{ transform: `translate(-50%, -50%) translate(${point.x}px,${point.y}px)` }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                draggingIndex.current = index;
                event.currentTarget.setPointerCapture(event.pointerId);
                setDraftWaypoints([...waypoints]);
              }}
              onPointerMove={(event) => {
                if (draggingIndex.current !== index) return;
                const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                setDraftWaypoints((current) => {
                  const next = [...(current ?? waypoints)];
                  next[index] = { x: Math.round(position.x), y: Math.round(position.y) };
                  return next;
                });
              }}
              onPointerUp={(event) => {
                if (draggingIndex.current !== index) return;
                draggingIndex.current = null;
                const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                const next = [...(draftWaypoints ?? waypoints)];
                next[index] = { x: Math.round(position.x), y: Math.round(position.y) };
                persistWaypoints(next);
              }}
              onPointerCancel={() => {
                draggingIndex.current = null;
                setDraftWaypoints(null);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                persistWaypoints(waypoints.filter((_, itemIndex) => itemIndex !== index));
              }}
              onKeyDown={(event) => {
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                event.stopPropagation();
                persistWaypoints(waypoints.filter((_, itemIndex) => itemIndex !== index));
              }}
            />
          ))}
        <button
          type="button"
          className={`architecture-edge-label edge-${type} nodrag nopan ${props.selected ? "is-selected" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            setConnectionSelected(props.id);
          }}
          style={{
            transform: `translate(-50%, -50%) translate(${labelPosition.x}px,${labelPosition.y}px)`,
          }}
        >
          <span className="edge-label-dot" />
          {label}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

function edgeColor(type: ArchitectureConnection["type"]) {
  if (type === "rest") return "#6B7F6E";
  if (type === "grpc") return "#6B7280";
  if (type === "database") return "#6B7F6E";
  if (type === "kafka" || type === "mqtt") return "#C9A892";
  return "#6B7280";
}
