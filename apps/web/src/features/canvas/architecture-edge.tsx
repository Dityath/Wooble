import { useContext, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { ArchitectureConnection, ConnectionBend, ConnectionPath } from "@wooble/domain";
import { useEditorStore } from "../../stores/editor-store";
import { connectionTitle } from "../../lib/connection-title";
import { ConnectorEditContext } from "./connector-edit-context";
import {
  applyPortOffset,
  buildConnectorRoute,
  closestRouteInsertion,
  routeEntersEndpoints,
  isHorizontalRoute,
  routeWaypoints,
  type ConnectorBox,
  type ConnectorSide,
} from "./connector-route";

export type ArchitectureFlowEdge = Edge<{
  connection: ArchitectureConnection & { bend: ConnectionPath };
  sourcePort?: { x: number; y: number };
  targetPort?: { x: number; y: number };
  /** Absolute card boxes, used to reject stored bends that would run through the endpoint cards. */
  sourceBox?: ConnectorBox;
  targetBox?: ConnectorBox;
  /** Label anchor for the whole graph, so every route keeps its label clear of the others. */
  labelPosition?: ConnectionBend;
  remotePeers?: { name: string; color: string }[];
}>;

export function ArchitectureEdge(props: EdgeProps<ArchitectureFlowEdge>) {
  const { editing, saving, saveBend } = useContext(ConnectorEditContext);
  const flow = useReactFlow();
  const setConnectionSelected = useEditorStore((state) => state.setConnectionSelected);
  const selectedConnectionId = useEditorStore((state) => state.selectedConnectionId);
  // Adding, removing and dropping a point publish straight to the graph, which owns the rendered route. Only a drag
  // needs a local draft, because it moves continuously and must not wait for the server.
  const [dragWaypoints, setDragWaypoints] = useState<ConnectionBend[] | null>(null);
  const draggingIndex = useRef<number | null>(null);
  const waypoints = dragWaypoints ?? routeWaypoints(props.data?.connection.bend ?? null);
  // Mirrors the rendered waypoints so a burst of keyboard events cannot apply to a value React has not re-rendered.
  const latest = useRef(waypoints);
  latest.current = waypoints;
  // Ports spread several connectors along one side; the handle sits mid-side, so shift by the port offset.
  const { x: sourceX, y: sourceY } = applyPortOffset({ x: props.sourceX, y: props.sourceY }, props.data?.sourcePort);
  const { x: targetX, y: targetY } = applyPortOffset({ x: props.targetX, y: props.targetY }, props.data?.targetPort);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: props.sourcePosition,
    targetX,
    targetY,
    targetPosition: props.targetPosition,
    borderRadius: 10,
    offset: 22,
  });
  const type = props.data?.connection.type ?? "rest";
  const label = props.data?.connection ? connectionTitle(props.data.connection) : "Connection";
  const horizontal = isHorizontalRoute(props.sourceHandleId, { x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  const route = buildConnectorRoute(
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    waypoints,
    horizontal,
    props.targetPosition as ConnectorSide,
  );
  // Stored bends from before direction-agnostic sides can run through an endpoint card: draw a plain path instead (dragging shows what the user drags).
  const { sourceBox, targetBox } = props.data ?? {};
  const stale =
    !dragWaypoints && !!sourceBox && !!targetBox && routeEntersEndpoints(route.segments, sourceBox, targetBox);
  const routed = waypoints.length > 0 && !stale;
  const path = routed ? route.path : edgePath;
  // Under the pointer the label follows the route being dragged; settled routes show the anchor the layout chose.
  const dragging = draggingIndex.current !== null;
  const labelPosition = routed
    ? dragging
      ? route.label
      : (props.data?.labelPosition ?? route.label)
    : { x: labelX, y: labelY };
  const active = selectedConnectionId === props.id;
  const remotePeer = props.data?.remotePeers?.[0];
  const editable = editing && !saving && active;
  const persistWaypoints = (next: ConnectionBend[]) => {
    // Applied to the mirror as well, so two edits in the same React batch build on each other instead of both
    // reading the route from before the first one.
    latest.current = next;
    void saveBend(props.id, next.length ? next : null);
  };
  const addWaypoint = (point: ConnectionBend) => {
    if (!editable || latest.current.length >= 12) return;
    const index = closestRouteInsertion(route.segments, point);
    const next = [...latest.current];
    next.splice(index, 0, point);
    persistWaypoints(next);
  };
  const removeWaypoint = (index: number) => {
    if (!editable) return;
    persistWaypoints(latest.current.filter((_, itemIndex) => itemIndex !== index));
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
        tabIndex={editable ? 0 : -1}
        onDoubleClick={(event) => {
          if (!editable || waypoints.length >= 12) return;
          event.preventDefault();
          event.stopPropagation();
          const flowPoint = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          addWaypoint({ x: Math.round(flowPoint.x), y: Math.round(flowPoint.y) });
        }}
        onKeyDown={(event) => {
          if (!editable || (event.key !== "Enter" && event.key !== " ")) return;
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
        {editable &&
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
                setDragWaypoints([...waypoints]);
              }}
              onPointerMove={(event) => {
                if (draggingIndex.current !== index) return;
                const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                setDragWaypoints((current) => {
                  const next = [...(current ?? waypoints)];
                  next[index] = { x: Math.round(position.x), y: Math.round(position.y) };
                  return next;
                });
              }}
              onPointerUp={(event) => {
                if (draggingIndex.current !== index) return;
                draggingIndex.current = null;
                const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                const next = [...(dragWaypoints ?? waypoints)];
                next[index] = { x: Math.round(position.x), y: Math.round(position.y) };
                persistWaypoints(next);
                setDragWaypoints(null);
              }}
              onPointerCancel={() => {
                draggingIndex.current = null;
                // A cancelled drag was never asked for, so fall back to the stored route.
                setDragWaypoints(null);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removeWaypoint(index);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                event.stopPropagation();
                removeWaypoint(index);
              }}
            />
          ))}
        <button
          type="button"
          className={`architecture-edge-label edge-${type} nodrag nopan ${props.selected ? "is-selected" : ""}`}
          // The chip ellipsises at the width Auto Neat reserved, so keep the full name reachable.
          title={label}
          onClick={(event) => {
            event.stopPropagation();
            setConnectionSelected(props.id);
          }}
          style={{
            transform: `translate(-50%, -50%) translate(${labelPosition.x}px,${labelPosition.y}px)`,
          }}
        >
          <span className="edge-label-dot" />
          <span className="edge-label-text">{label}</span>
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
