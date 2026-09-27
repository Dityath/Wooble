import { useCallback, useContext } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import { Boxes, Cpu, Database, Globe2, Layers3, RadioTower, Server, Workflow } from "lucide-react";
import type { ArchitectureEntity, EntityType } from "@wooble/domain";
import technologyCatalog from "../inspector/technology-catalog.json";
import { TechnologyIcon } from "../inspector/technology-icon";
import type { SystemResizeBounds } from "./system-resize";
import { SystemResizeContext } from "./system-resize-context";

export interface ArchitectureNodeData extends Record<string, unknown> {
  entity: ArchitectureEntity;
  remotePeers?: { name: string; color: string }[];
  childCount?: number;
  subtitle?: string;
}
export type ArchitectureFlowNode = Node<ArchitectureNodeData>;

export function SystemNode({ id, data, selected }: NodeProps<ArchitectureFlowNode>) {
  const entity = data.entity;
  const resize = useContext(SystemResizeContext);
  const canResize = useCallback(
    (_event: unknown, bounds: SystemResizeBounds) => resize.canResize(id, bounds),
    [id, resize],
  );
  const onResizeStart = useCallback(() => resize.onStart(id), [id, resize]);
  const onResizeEnd = useCallback(
    (_event: unknown, bounds: SystemResizeBounds) => resize.onEnd(id, bounds),
    [id, resize],
  );
  return (
    <>
      <NodeResizer
        isVisible={selected && resize.enabled}
        minWidth={300}
        minHeight={220}
        lineClassName="system-resize-line"
        handleClassName="system-resize-handle"
        shouldResize={canResize}
        onResizeStart={onResizeStart}
        onResizeEnd={onResizeEnd}
      />
      <div
        className={`system-boundary ${selected ? "is-selected" : ""}`}
        style={
          data.remotePeers?.length ? ({ "--peer-color": data.remotePeers[0].color } as React.CSSProperties) : undefined
        }
      >
        {data.remotePeers?.map((peer) => (
          <span
            key={peer.name}
            className="remote-selection-tag"
            style={{ "--peer-color": peer.color } as React.CSSProperties}
          >
            {peer.name} selected
          </span>
        ))}
        <div className="system-boundary-head">
          <span className="system-boundary-icon">
            <Boxes size={15} />
          </span>
          <div className="system-boundary-title">{entity.name || "New system"}</div>
          <span className="system-boundary-count">{data.childCount ?? 0} components</span>
          <button type="button" className="system-boundary-menu" tabIndex={-1} aria-label="System options">
            ···
          </button>
        </div>
        {entity.description && <div className="system-boundary-description">{entity.description}</div>}
      </div>
    </>
  );
}

const kindPresentation = {
  frontend: { label: "Frontend", icon: Globe2, accent: "node-accent-blue", badge: "blue" as const },
  device: { label: "IoT device", icon: Cpu, accent: "node-accent-amber", badge: "amber" as const },
  gateway: { label: "API gateway", icon: Workflow, accent: "node-accent-violet", badge: "violet" as const },
  service: { label: "Service", icon: Server, accent: "node-accent-slate", badge: "default" as const },
  database: { label: "Database", icon: Database, accent: "node-accent-emerald", badge: "green" as const },
  broker: { label: "Message broker", icon: RadioTower, accent: "node-accent-amber", badge: "amber" as const },
  external: { label: "External system", icon: Layers3, accent: "node-accent-neutral", badge: "default" as const },
} as const;

export function EntityKindIcon({ type, size = 15 }: { type: EntityType; size?: number }) {
  const Icon = type === "system" ? Boxes : kindPresentation[type].icon;
  return <Icon size={size} strokeWidth={1.9} />;
}

function ArchitectureNodeCard({ data, selected }: NodeProps<ArchitectureFlowNode>) {
  const entity = data.entity;
  const presentation = kindPresentation[entity.type === "system" ? "external" : entity.type];
  const metadata = entity.metadata;
  const title =
    (entity.type === "device"
      ? (metadata.technology ?? metadata.language)
      : (metadata.language ?? metadata.technology)) ??
    metadata.engine ??
    metadata.framework ??
    presentation.label;
  const secondary =
    entity.type === "database"
      ? metadata.version
        ? `Version ${metadata.version}`
        : "Data store"
      : metadata.framework && metadata.framework !== metadata.language
        ? metadata.framework
        : null;
  const titleTechnologyId = technologyCatalog.find((item) => item.label.toLowerCase() === title.toLowerCase())?.id;
  const secondaryTechnologyId = secondary
    ? technologyCatalog.find((item) => item.label.toLowerCase() === secondary.toLowerCase())?.id
    : null;
  return (
    <div
      className={`architecture-node ${presentation.accent} ${selected ? "is-selected" : ""}`}
      style={
        data.remotePeers?.length ? ({ "--peer-color": data.remotePeers[0].color } as React.CSSProperties) : undefined
      }
    >
      {data.remotePeers?.map((peer) => (
        <span
          key={peer.name}
          className="remote-selection-tag"
          style={{ "--peer-color": peer.color } as React.CSSProperties}
        >
          {peer.name} selected
        </span>
      ))}
      <Handle type="target" id="target-left" position={Position.Left} isConnectable={false} className="node-handle" />
      <Handle type="source" id="source-right" position={Position.Right} isConnectable={false} className="node-handle" />
      <Handle type="target" id="target-top" position={Position.Top} isConnectable={false} className="node-handle" />
      <Handle
        type="source"
        id="source-bottom"
        position={Position.Bottom}
        isConnectable={false}
        className="node-handle"
      />
      <Handle type="source" id="source-left" position={Position.Left} isConnectable={false} className="node-handle" />
      <Handle type="target" id="target-right" position={Position.Right} isConnectable={false} className="node-handle" />
      <Handle type="source" id="source-top" position={Position.Top} isConnectable={false} className="node-handle" />
      <Handle
        type="target"
        id="target-bottom"
        position={Position.Bottom}
        isConnectable={false}
        className="node-handle"
      />
      <div className="architecture-node-top">
        <span className="architecture-node-icon">
          <EntityKindIcon type={entity.type} size={15} />
        </span>
        <span className="architecture-node-kind">{presentation.label}</span>
        {entity.type === "service" && metadata.status && (
          <span className={`status-dot status-${metadata.status}`} title={metadata.status} />
        )}
      </div>
      <div className="architecture-node-name">{entity.name || "New node"}</div>
      <div className="architecture-node-tech">
        <span className="architecture-node-tech-part">
          {titleTechnologyId && <TechnologyIcon id={titleTechnologyId} />}
          <span>{title}</span>
        </span>
        {secondary ? (
          <>
            <span className="node-separator">·</span>
            <span className="architecture-node-tech-part">
              {secondaryTechnologyId && <TechnologyIcon id={secondaryTechnologyId} />}
              <span>{secondary}</span>
            </span>
          </>
        ) : null}
      </div>
      {data.subtitle && <div className="architecture-node-subtitle">{data.subtitle}</div>}
    </div>
  );
}

export function FrontendNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function DeviceNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function GatewayNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function ServiceNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function DatabaseNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function BrokerNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
export function ExternalNode(props: NodeProps<ArchitectureFlowNode>) {
  return <ArchitectureNodeCard {...props} />;
}
