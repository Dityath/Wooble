import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Box,
  Braces,
  ChevronRight,
  Cpu,
  Database,
  ExternalLink,
  GitBranch,
  Layers3,
  Pencil,
  Trash2,
  Server,
  X,
} from "lucide-react";
import {
  canvasSubtreeIds,
  type ArchitectureConnection,
  type ArchitectureEntity,
  type ConnectionType,
  type EntityType,
} from "@wooble/domain";
import { api, type CanvasGraph } from "../../lib/api";
import { connectionTitle } from "../../lib/connection-title";
import { useEditorStore } from "../../stores/editor-store";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui";
import { TechnologyDialog } from "./technology-dialog";
import technologyCatalog from "./technology-catalog.json";
import { technologyGroupsByType, technologyItemsForGroup } from "./technology-groups";
import { TechnologyName } from "./technology-icon";
import { RichDocumentation } from "./rich-documentation";
import { DatabaseSchema } from "./database-schema";
import { ContractEditor } from "./contract-editor";

const entityLabels: Record<string, string> = {
  system: "System",
  frontend: "Frontend",
  device: "IoT device",
  gateway: "API gateway",
  service: "Service",
  database: "Database",
  broker: "Message broker",
  external: "External",
};
type DetailSection = "overview" | "documentation" | "schema" | "contract";
const typeIcon: Record<string, typeof Server> = {
  system: Layers3,
  frontend: Box,
  device: Cpu,
  gateway: GitBranch,
  service: Server,
  database: Database,
  broker: Braces,
  external: Box,
};

function TechnologyStackTags({ entity }: { entity: ArchitectureEntity }) {
  const stack = entity.metadata.technologyStack ?? [];
  const tag = (id: string) => (
    <Badge key={id}>
      <TechnologyName
        id={id}
        label={technologyCatalog.find((item) => item.id === id)?.label ?? id}
        version={entity.metadata.technologyVersions?.[id]}
      />
    </Badge>
  );

  if (entity.type !== "device") return <div className="tag-row technology-tags">{stack.map(tag)}</div>;

  const groups = technologyGroupsByType.device.map((group) => ({
    label: group.label,
    ids: technologyItemsForGroup(group)
      .map((item) => item.id)
      .filter((id) => stack.includes(id)),
  }));
  const groupedIds = new Set(groups.flatMap((group) => group.ids));
  const previousIds = stack.filter((id) => !groupedIds.has(id));

  return (
    <div className="device-technology-groups">
      {groups
        .filter((group) => group.ids.length > 0)
        .map((group) => (
          <div className="device-technology-group" key={group.label}>
            <div className="device-technology-group-label">{group.label}</div>
            <div className="tag-row technology-tags">{group.ids.map(tag)}</div>
          </div>
        ))}
      {previousIds.length > 0 && (
        <div className="device-technology-group">
          <div className="device-technology-group-label">Previously selected</div>
          <div className="tag-row technology-tags">{previousIds.map(tag)}</div>
        </div>
      )}
    </div>
  );
}

export function InspectorPanel({
  graph,
  canvasId,
  onOpenDetails,
  deleteRequest,
  mode = "overview",
  detailSection = "overview",
  onSelectDetailSection,
}: {
  graph: CanvasGraph;
  canvasId: string;
  onOpenDetails?: (section: DetailSection) => void;
  /** A serial-stamped request to open the delete confirmation, e.g. from Backspace/Delete. */
  deleteRequest?: { serial: number } | null;
  mode?: "overview" | "details";
  detailSection?: DetailSection;
  onSelectDetailSection?: (section: DetailSection) => void;
}) {
  const selectedEntityId = useEditorStore((state) => state.selectedEntityId);
  const selectedConnectionId = useEditorStore((state) => state.selectedConnectionId);
  const setEntitySelected = useEditorStore((state) => state.setEntitySelected);
  const setConnectionSelected = useEditorStore((state) => state.setConnectionSelected);
  const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const entity = selectedEntityId ? entityMap.get(selectedEntityId) : undefined;
  const connection = selectedConnectionId
    ? graph.connections.find((item) => item.id === selectedConnectionId)
    : undefined;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [technologyOpen, setTechnologyOpen] = useState(false);
  const [editingInline, setEditingInline] = useState(false);
  const viewMode = mode === "overview" && editingInline ? "settings" : mode;
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Seeded with the incoming request so a stale serial left by a previous
  // selection cannot reopen the dialog when this panel remounts; only requests
  // newer than the mount open it.
  const openedDeleteRequest = useRef(deleteRequest);
  useEffect(() => {
    if (deleteRequest && deleteRequest !== openedDeleteRequest.current) {
      openedDeleteRequest.current = deleteRequest;
      setDeleteOpen(true);
    }
  }, [deleteRequest]);
  const removedNodeCount = entity ? canvasSubtreeIds(graph.placements, entity.id).length : 0;
  const deleteSelected = async () => {
    if (!entity && !connection) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (entity) await api.deleteCanvasEntity(canvasId, entity.id);
      else if (connection) await api.deleteCanvasConnection(canvasId, connection.id);
      clear();
      setDeleteOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] }),
        queryClient.invalidateQueries({ queryKey: ["canvases"] }),
      ]);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete item");
    } finally {
      setDeleting(false);
    }
  };
  const clear = () => {
    setEntitySelected(null);
    setConnectionSelected(null);
  };

  return (
    <aside className="inspector-panel">
      {mode === "overview" && (entity || connection) && (
        <div className={`inspector-header-actions${editingInline ? " inline-edit-actions" : ""}`}>
          {editingInline ? (
            <Button variant="ghost" size="sm" onClick={() => setEditingInline(false)}>
              <ArrowLeft size={15} /> Back to overview
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="inspector-edit"
              onClick={() => setEditingInline(true)}
              aria-label="Edit in sidebar"
            >
              <Pencil size={16} />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="inspector-close" onClick={clear} aria-label="Close inspector">
            <X size={16} />
          </Button>
        </div>
      )}
      {entity ? (
        <div
          className={`inspector-scroll ${viewMode === "overview" ? "" : "detail-mode"}${editingInline ? " inline-settings" : ""}`}
        >
          {viewMode === "overview" ? (
            <EntityInspector
              entity={entity}
              graph={graph}
              entities={entityMap}
              onOpenDetails={onOpenDetails}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : viewMode === "settings" ? (
            <EntityAssignmentForm
              entity={entity}
              canvasId={canvasId}
              onOpenTechnology={() => setTechnologyOpen(true)}
            />
          ) : (
            <EntityDetailContent
              entity={entity}
              graph={graph}
              canvasId={canvasId}
              section={detailSection}
              onSelect={onSelectDetailSection}
            />
          )}
        </div>
      ) : connection ? (
        <div
          className={`inspector-scroll ${viewMode === "overview" ? "" : "detail-mode"}${editingInline ? " inline-settings" : ""}`}
        >
          {viewMode === "overview" ? (
            <ConnectionInspector
              connection={connection}
              entities={entityMap}
              onOpenDetails={onOpenDetails}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : viewMode === "settings" ? (
            <ConnectionAssignmentForm connection={connection} canvasId={canvasId} />
          ) : (
            <ConnectionDetailContent
              connection={connection}
              entities={entityMap}
              canvasId={canvasId}
              section={detailSection}
              onSelect={onSelectDetailSection}
            />
          )}
        </div>
      ) : (
        <EmptyInspector />
      )}
      {entity && (
        <TechnologyDialog
          key={`${entity.id}:${entity.updatedAt}`}
          entity={entity}
          canvasId={canvasId}
          open={technologyOpen}
          onOpenChange={setTechnologyOpen}
        />
      )}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="inspector-delete-dialog">
          <DialogTitle>Delete {entity?.name || connection?.label || "item"}?</DialogTitle>
          <DialogDescription>
            {entity
              ? removedNodeCount > 1
                ? `This removes the system and ${removedNodeCount - 1} contained node${removedNodeCount === 2 ? "" : "s"}, plus their connections, from this canvas.`
                : "This removes the node and its connections from this canvas."
              : "This removes the connection from this canvas."}
          </DialogDescription>
          {deleteError && (
            <p role="alert" className="form-error">
              {deleteError}
            </p>
          )}
          <div className="inspector-delete-actions">
            <Button variant="secondary" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button className="inspector-delete-confirm" onClick={() => void deleteSelected()} disabled={deleting}>
              <Trash2 size={15} /> {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

type EntityFieldKey = "type" | "name" | "description" | "status" | "version" | "repositoryUrl" | "artifactUrl";
type EntityField = {
  key: EntityFieldKey;
  label: string;
  value: string;
  placeholder: string;
  maxLength?: number;
  kind?: "select" | "textarea";
  options?: Array<{ value: string; label: string }>;
};

function isInlineCancelTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-cancel-inline-edit]"));
}

function EntityAssignmentForm({
  entity,
  canvasId,
  onOpenTechnology,
}: {
  entity: ArchitectureEntity;
  canvasId: string;
  onOpenTechnology: () => void;
}) {
  const queryClient = useQueryClient();
  const [activeField, setActiveField] = useState<EntityFieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (activeField) (selectRef.current ?? textareaRef.current ?? inputRef.current)?.focus();
  }, [activeField]);
  useEffect(() => {
    if (error && !saving) (selectRef.current ?? textareaRef.current ?? inputRef.current)?.focus();
  }, [error, saving]);
  const fields: EntityField[] = [
    { key: "name", label: "Name", value: entity.name, placeholder: "Choose a name", maxLength: 100 },
    {
      key: "description",
      label: "Description",
      value: entity.description ?? "",
      placeholder: "Add a description",
      maxLength: 500,
      kind: "textarea",
    },
  ];
  if (entity.type !== "system") {
    fields.unshift({
      key: "type",
      label: "Type",
      value: entity.type,
      placeholder: "Type",
      kind: "select",
      options: [
        { value: "service", label: "Service" },
        { value: "frontend", label: "Frontend" },
        { value: "device", label: "IoT device" },
        { value: "gateway", label: "API gateway" },
        { value: "database", label: "Database" },
        { value: "broker", label: "Message broker" },
        { value: "external", label: "External" },
      ],
    });
    fields.push({
      key: "status",
      label: "Status",
      value: entity.metadata.status ?? "",
      placeholder: "Not set",
      kind: "select",
      options: [
        { value: "", label: "Not set" },
        { value: "planned", label: "Planned" },
        { value: "in-progress", label: "In progress" },
        { value: "implemented", label: "Implemented" },
        { value: "deprecated", label: "Deprecated" },
      ],
    });
    if (entity.type === "database") {
      fields.push({
        key: "version",
        label: "Version",
        value: entity.metadata.version ?? "",
        placeholder: "e.g. 16",
        maxLength: 100,
      });
    }
    fields.push(
      {
        key: "repositoryUrl",
        label: "Repository URL",
        value: entity.metadata.repositoryUrl ?? "",
        placeholder: "Not added",
        maxLength: 500,
      },
      {
        key: "artifactUrl",
        label: "Artifact URL or reference",
        value: entity.metadata.artifactUrl ?? "",
        placeholder: "Not added",
        maxLength: 500,
      },
    );
  }

  const commit = async (field: EntityField, nextValue: string) => {
    if (cancelled.current || saving) return;
    const value = nextValue.trim();
    if (value === field.value) {
      setActiveField(null);
      setError(null);
      return;
    }
    if (field.key === "name" && !value) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      switch (field.key) {
        case "type":
          await api.updateEntity(entity.id, { type: value as EntityType });
          break;
        case "name":
          await api.updateEntity(entity.id, { name: value });
          break;
        case "description":
          await api.updateEntity(entity.id, { description: value || null });
          break;
        default:
          await api.updateEntity(entity.id, { metadata: { [field.key]: value || null } });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] }),
        queryClient.invalidateQueries({ queryKey: ["canvases"] }),
      ]);
      setActiveField(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not update ${field.label.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inspector-field-editor">
      <div className="inspector-form-intro">
        <h2>{entity.type === "system" ? "Edit system" : "Edit node"}</h2>
      </div>
      <div className="inspector-field-list">
        {fields.map((field) => {
          const active = activeField === field.key;
          const displayValue = field.options?.find((option) => option.value === field.value)?.label ?? field.value;
          return (
            <div className={`inspector-field ${active ? "is-editing" : ""}`} key={field.key}>
              <div className="inspector-field-heading">
                <span>{field.label}</span>
                {active ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="cancel-inline-edit"
                    data-cancel-inline-edit="true"
                    disabled={saving}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      cancelled.current = true;
                      setError(null);
                      setActiveField(null);
                    }}
                    aria-label={`Cancel editing ${field.label.toLowerCase()}`}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving || activeField !== null}
                    onClick={() => {
                      cancelled.current = false;
                      setError(null);
                      setDraft(field.value);
                      setActiveField(field.key);
                    }}
                    aria-label={`Edit ${field.label.toLowerCase()}`}
                  >
                    <Pencil size={13} /> Edit
                  </Button>
                )}
              </div>
              {active ? (
                field.kind === "select" ? (
                  <select
                    aria-label={field.label}
                    ref={selectRef}
                    data-inline-editing="true"
                    value={draft}
                    disabled={saving}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      void commit(field, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      }
                    }}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.kind === "textarea" ? (
                  <textarea
                    aria-label={field.label}
                    ref={textareaRef}
                    data-inline-editing="true"
                    value={draft}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    rows={3}
                    disabled={saving}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={(event) => {
                      if (!isInlineCancelTarget(event.relatedTarget)) void commit(field, draft);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <input
                    aria-label={field.label}
                    ref={inputRef}
                    data-inline-editing="true"
                    value={draft}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    disabled={saving}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={(event) => {
                      if (!isInlineCancelTarget(event.relatedTarget)) void commit(field, draft);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      } else if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                )
              ) : (
                <div className={`inspector-field-value ${field.value ? "" : "is-empty"}`}>
                  {field.key === "type" && entity.type === "system" ? "System box" : displayValue || field.placeholder}
                </div>
              )}
              {active && !saving && !error && (
                <span className="inspector-field-note">
                  {field.kind === "select"
                    ? "Choose an option to save · Cancel or Esc to discard"
                    : field.kind === "textarea"
                      ? "Click outside or press Ctrl/⌘ Enter to save · Cancel or Esc to discard"
                      : "Click outside or press Enter to save · Cancel or Esc to discard"}
                </span>
              )}
              {active && saving && (
                <span className="inspector-field-note" role="status">
                  Saving…
                </span>
              )}
              {active && error && (
                <span className="form-error" role="alert">
                  {error}
                </span>
              )}
            </div>
          );
        })}
        {entity.type !== "system" && (
          <div className="inspector-field">
            <div className="inspector-field-heading">
              <span>Technology stack</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onOpenTechnology}
                disabled={saving || activeField !== null}
              >
                <Pencil size={13} /> Edit
              </Button>
            </div>
            <div className={`inspector-field-value ${entity.metadata.technologyStack?.length ? "" : "is-empty"}`}>
              {entity.metadata.technologyStack?.length ? <TechnologyStackTags entity={entity} /> : "Not added"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ConnectionFieldKey = "type" | "label" | "description" | "contract" | "direction";
type ConnectionField = {
  key: ConnectionFieldKey;
  label: string;
  value: string;
  placeholder: string;
  maxLength?: number;
  kind?: "select" | "textarea";
  options?: Array<{ value: string; label: string }>;
};

function ConnectionAssignmentForm({ connection, canvasId }: { connection: ArchitectureConnection; canvasId: string }) {
  const queryClient = useQueryClient();
  const [activeField, setActiveField] = useState<ConnectionFieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (activeField) (selectRef.current ?? textareaRef.current ?? inputRef.current)?.focus();
  }, [activeField]);
  useEffect(() => {
    if (error && !saving) (selectRef.current ?? textareaRef.current ?? inputRef.current)?.focus();
  }, [error, saving]);
  const fields: ConnectionField[] = [
    {
      key: "type",
      label: "Protocol",
      value: connection.type,
      placeholder: "Protocol",
      kind: "select",
      options: [
        { value: "rest", label: "REST" },
        { value: "grpc", label: "gRPC" },
        { value: "database", label: "Database" },
        { value: "mqtt", label: "MQTT" },
        { value: "nats", label: "NATS" },
        { value: "kafka", label: "Kafka" },
      ],
    },
    { key: "label", label: "Label", value: connection.label, placeholder: "Add a label", maxLength: 100 },
    {
      key: "description",
      label: "Description",
      value: connection.description ?? "",
      placeholder: "Add a description",
      maxLength: 500,
      kind: "textarea",
    },
    {
      key: "contract",
      label: "Contract reference",
      value: connection.metadata.contract ?? "",
      placeholder: "Not configured",
      maxLength: 500,
    },
    {
      key: "direction",
      label: "Direction",
      value: connection.metadata.direction ?? "one-way",
      placeholder: "One way",
      kind: "select",
      options: [
        { value: "one-way", label: "One way" },
        { value: "two-way", label: "Two way" },
      ],
    },
  ];

  const commit = async (field: ConnectionField, nextValue: string) => {
    if (cancelled.current || saving) return;
    const value = nextValue.trim();
    if (value === field.value) {
      setActiveField(null);
      setError(null);
      return;
    }
    if (field.key === "label" && !value) {
      setError("Label is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      switch (field.key) {
        case "type":
          await api.updateConnection(connection.id, { type: value as ConnectionType });
          break;
        case "label":
          await api.updateConnection(connection.id, { label: value });
          break;
        case "description":
          await api.updateConnection(connection.id, { description: value || null });
          break;
        case "direction":
          await api.updateConnection(connection.id, { metadata: { direction: value as "one-way" | "two-way" } });
          break;
        case "contract":
          await api.updateConnection(connection.id, { metadata: { contract: value || null } });
      }
      await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
      setActiveField(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not update ${field.label.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="inspector-field-editor" aria-label="Connection settings">
      <div className="inspector-form-intro">
        <h2>Edit connection</h2>
      </div>
      <div className="inspector-field-list">
        {fields.map((field) => {
          const active = activeField === field.key;
          const displayValue = field.options?.find((option) => option.value === field.value)?.label ?? field.value;
          return (
            <div className={`inspector-field ${active ? "is-editing" : ""}`} key={field.key}>
              <div className="inspector-field-heading">
                <span>{field.label}</span>
                {active ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="cancel-inline-edit"
                    data-cancel-inline-edit="true"
                    disabled={saving}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      cancelled.current = true;
                      setError(null);
                      setActiveField(null);
                    }}
                    aria-label={`Cancel editing ${field.label.toLowerCase()}`}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving || activeField !== null}
                    onClick={() => {
                      cancelled.current = false;
                      setError(null);
                      setDraft(field.value);
                      setActiveField(field.key);
                    }}
                    aria-label={`Edit ${field.label.toLowerCase()}`}
                  >
                    <Pencil size={13} /> Edit
                  </Button>
                )}
              </div>
              {active ? (
                field.kind === "select" ? (
                  <select
                    aria-label={field.label}
                    ref={selectRef}
                    data-inline-editing="true"
                    value={draft}
                    disabled={saving}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      void commit(field, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      }
                    }}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.kind === "textarea" ? (
                  <textarea
                    aria-label={field.label}
                    ref={textareaRef}
                    data-inline-editing="true"
                    value={draft}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    rows={3}
                    disabled={saving}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={(event) => {
                      if (!isInlineCancelTarget(event.relatedTarget)) void commit(field, draft);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <input
                    aria-label={field.label}
                    ref={inputRef}
                    data-inline-editing="true"
                    value={draft}
                    maxLength={field.maxLength}
                    placeholder={field.placeholder}
                    disabled={saving}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={(event) => {
                      if (!isInlineCancelTarget(event.relatedTarget)) void commit(field, draft);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelled.current = true;
                        setActiveField(null);
                      } else if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                )
              ) : (
                <div className={`inspector-field-value ${field.value ? "" : "is-empty"}`}>
                  {displayValue || field.placeholder}
                </div>
              )}
              {active && !saving && !error && (
                <span className="inspector-field-note">
                  {field.kind === "select"
                    ? "Choose an option to save · Cancel or Esc to discard"
                    : field.kind === "textarea"
                      ? "Click outside or press Ctrl/⌘ Enter to save · Cancel or Esc to discard"
                      : "Click outside or press Enter to save · Cancel or Esc to discard"}
                </span>
              )}
              {active && saving && (
                <span className="inspector-field-note" role="status">
                  Saving…
                </span>
              )}
              {active && error && (
                <span className="form-error" role="alert">
                  {error}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EntityInspector({
  entity,
  graph,
  entities,
  onOpenDetails,
  onDelete,
}: {
  entity: ArchitectureEntity;
  graph: CanvasGraph;
  entities: Map<string, ArchitectureEntity>;
  onOpenDetails?: (section: DetailSection) => void;
  onDelete?: () => void;
}) {
  const Icon = typeIcon[entity.type] ?? Box;
  const metadata = entity.metadata;
  const belongs = graph.placements.filter((placement) => placement.parentEntityId === entity.id).length;
  const databaseConnections = graph.connections.filter(
    (connection) =>
      connection.type === "database" &&
      (connection.sourceEntityId === entity.id || connection.targetEntityId === entity.id),
  );
  const relatedServices = databaseConnections
    .map((connection) =>
      entity.id === connection.sourceEntityId ? connection.targetEntityId : connection.sourceEntityId,
    )
    .map((id) => graph.entities.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is ArchitectureEntity => candidate?.type === "service");
  const dataConnections = graph.connections.filter(
    (connection) => connection.sourceEntityId === entity.id || connection.targetEntityId === entity.id,
  );

  return (
    <div className="inspector-content">
      <div className="inspector-entity-title-row">
        <div className={`inspector-kind-icon kind-${entity.type}`}>
          <Icon size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="inspector-entity-title">
            {entity.name || (entity.type === "system" ? "New system" : "New node")}
          </h2>
          <Badge
            variant={
              entity.type === "database"
                ? "green"
                : entity.type === "frontend"
                  ? "blue"
                  : entity.type === "gateway"
                    ? "violet"
                    : "default"
            }
          >
            {entityLabels[entity.type]}
          </Badge>
          {entity.type !== "system" && metadata.status && (
            <span className="inspector-status status-value">
              <span className={`status-dot status-${metadata.status}`} />
              {metadata.status.replace("-", " ")}
            </span>
          )}
        </div>
      </div>
      {entity.description && <p className="inspector-description">{entity.description}</p>}

      {entity.type === "system" && (
        <Section title="COMPONENTS" trailing={<span>{belongs}</span>}>
          <div className="inspector-list">
            {graph.placements
              .filter((placement) => placement.parentEntityId === entity.id)
              .map((placement) => {
                const child = graph.entities.find((candidate) => candidate.id === placement.entityId);
                if (!child) return null;
                return (
                  <div key={child.id} className="relation-row">
                    <span className={`relation-dot dot-${child.type}`} />
                    <span>{child.name}</span>
                    <span className="relation-type">{entityLabels[child.type]}</span>
                  </div>
                );
              })}
          </div>
        </Section>
      )}

      {entity.type === "service" && (
        <>
          {!metadata.technologyStack?.length && (
            <Section title="TECHNOLOGY">
              <div className="technology-pair">
                <span>{metadata.language ?? "Language not set"}</span>
                <span className="technology-divider" />
                <span>{metadata.framework ?? "Framework not set"}</span>
              </div>
            </Section>
          )}
          {metadata.interfaces && metadata.interfaces.length > 0 && (
            <Section title="API PROTOCOLS">
              <div className="tag-row">
                {metadata.interfaces.map((item) => (
                  <Badge key={item} variant={item === "gRPC" ? "violet" : "blue"}>
                    {item}
                  </Badge>
                ))}
              </div>
            </Section>
          )}
          <Section title="DATABASE">
            <div className="inspector-list">
              {databaseConnections.length ? (
                databaseConnections.map((item) => {
                  const dbId = item.sourceEntityId === entity.id ? item.targetEntityId : item.sourceEntityId;
                  const database = entities.get(dbId);
                  return (
                    <div key={item.id} className="relation-row">
                      <Database size={14} className="text-primary" />
                      <span>{database?.name ?? "Database"}</span>
                      <span className="relation-type">{database?.metadata.engine ?? ""}</span>
                    </div>
                  );
                })
              ) : (
                <div className="placeholder-line">No database connection</div>
              )}
            </div>
          </Section>
          <Section title="SOURCE">
            <ExternalValue label="Repository" value={metadata.repositoryUrl} />
            <ExternalValue label="Artifact" value={metadata.artifactUrl} />
          </Section>
        </>
      )}

      {entity.type === "database" && (
        <>
          <Section title="ENGINE">
            <div className="database-engine">
              <Database size={16} />
              <span>{metadata.engine ?? "Engine not set"}</span>
              {metadata.version && <Badge>{metadata.version}</Badge>}
            </div>
          </Section>
          <Section title="CONNECTED SERVICES">
            <div className="inspector-list">
              {relatedServices.length ? (
                relatedServices.map((service) => (
                  <div key={service.id} className="relation-row">
                    <Server size={14} className="text-muted-foreground" />
                    <span>{service.name}</span>
                    <ChevronRight size={13} className="ml-auto text-muted-foreground" />
                  </div>
                ))
              ) : (
                <div className="placeholder-line">No services connected</div>
              )}
            </div>
          </Section>
          <Section title="TABLES">
            <div className="coming-soon">
              <span className="coming-soon-icon">
                <Braces size={15} />
              </span>
              <span>
                <b>Schema not connected</b>
                <small>Tables and relationships will appear here.</small>
              </span>
            </div>
            <Button size="sm" variant="secondary" className="w-full mt-3" disabled>
              View schema
            </Button>
          </Section>
        </>
      )}

      {(entity.type === "frontend" ||
        entity.type === "device" ||
        entity.type === "gateway" ||
        entity.type === "broker" ||
        entity.type === "external") && (
        <>
          {!metadata.technologyStack?.length && (
            <Section title="TECHNOLOGY">
              <div className="technology-pair">
                <span>
                  {entity.type === "device"
                    ? (metadata.technology ?? metadata.language ?? "Not specified")
                    : (metadata.language ?? metadata.technology ?? "Not specified")}
                </span>
                {metadata.framework && (
                  <>
                    <span className="technology-divider" />
                    <span>{metadata.framework}</span>
                  </>
                )}
              </div>
            </Section>
          )}
          <Section title="CONNECTED TO">
            <div className="inspector-list">
              {dataConnections.length ? (
                dataConnections.map((item) => {
                  const id = item.sourceEntityId === entity.id ? item.targetEntityId : item.sourceEntityId;
                  const target = entities.get(id);
                  return (
                    <div key={item.id} className="relation-row">
                      <span className={`relation-dot dot-${target?.type ?? "external"}`} />
                      <span>{target?.name ?? "Unknown"}</span>
                      <Badge>{item.label}</Badge>
                    </div>
                  );
                })
              ) : (
                <div className="placeholder-line">No connections yet</div>
              )}
            </div>
          </Section>
        </>
      )}

      {entity.type !== "system" && metadata.technologyStack && metadata.technologyStack.length > 0 && (
        <Section title="TECH STACK">
          <TechnologyStackTags entity={entity} />
        </Section>
      )}
      {entity.type !== "service" && entity.type !== "system" && (metadata.repositoryUrl || metadata.artifactUrl) && (
        <Section title="SOURCE">
          <ExternalValue label="Repository" value={metadata.repositoryUrl} />
          <ExternalValue label="Artifact" value={metadata.artifactUrl} />
        </Section>
      )}
      <div className="inspector-footer">
        {onOpenDetails && (
          <Button variant="secondary" className="w-full" onClick={() => onOpenDetails("overview")}>
            Open details <ArrowUpRight size={14} />
          </Button>
        )}
        {onOpenDetails && (
          <div className="inspector-shortcuts">
            <Button variant="outline" onClick={() => onOpenDetails("documentation")}>
              Documentation
            </Button>
            {entity.type === "database" && (
              <Button variant="outline" onClick={() => onOpenDetails("schema")}>
                Database schema
              </Button>
            )}
          </div>
        )}
        {onDelete && (
          <Button variant="outline" className="w-full inspector-delete-trigger" onClick={onDelete}>
            <Trash2 size={14} /> Delete
          </Button>
        )}
        <div className="updated-label">Updated {formatDate(entity.updatedAt)}</div>
      </div>
    </div>
  );
}

function ConnectionInspector({
  connection,
  entities,
  onOpenDetails,
  onDelete,
}: {
  connection: ArchitectureConnection;
  entities: Map<string, ArchitectureEntity>;
  onOpenDetails?: (section: DetailSection) => void;
  onDelete?: () => void;
}) {
  const source = entities.get(connection.sourceEntityId);
  const target = entities.get(connection.targetEntityId);
  return (
    <div className="inspector-content">
      <div className="connection-heading">
        <div className={`connection-protocol-icon protocol-${connection.type}`}>
          <ArrowDownLeft size={17} />
        </div>
        <div>
          <h2 className="inspector-entity-title">{connectionTitle(connection)}</h2>
          <Badge variant={connection.type === "database" ? "green" : connection.type === "grpc" ? "violet" : "blue"}>
            {connection.type.toUpperCase()}
          </Badge>
        </div>
      </div>
      {connection.description && <p className="inspector-description">{connection.description}</p>}
      <Section title="FLOW">
        <div className="flow-endpoint">
          <div className="flow-endpoint-icon">
            <ArrowUpRight size={14} />
          </div>
          <span>
            <small>SOURCE</small>
            <b>{source?.name ?? "Unknown entity"}</b>
          </span>
        </div>
        <div className="flow-connector-line" />
        <div className="flow-endpoint">
          <div className="flow-endpoint-icon">
            <ArrowDownLeft size={14} />
          </div>
          <span>
            <small>TARGET</small>
            <b>{target?.name ?? "Unknown entity"}</b>
          </span>
        </div>
      </Section>
      <Section title="CONTRACT">
        <div className="contract-placeholder">
          <Braces size={15} />
          <span>{connection.metadata.contract ?? "Not configured"}</span>
        </div>
        <p className="contract-note">
          {connection.metadata.contractBody
            ? "Open details to view or edit the contract."
            : "Open details to add OpenAPI, Proto, or contract notes."}
        </p>
      </Section>
      <div className="inspector-footer">
        {onOpenDetails && (
          <Button variant="secondary" className="w-full" onClick={() => onOpenDetails("overview")}>
            Open details <ArrowUpRight size={14} />
          </Button>
        )}
        {onOpenDetails && (
          <div className="inspector-shortcuts">
            <Button variant="outline" onClick={() => onOpenDetails("contract")}>
              Contract
            </Button>
            <Button variant="outline" onClick={() => onOpenDetails("documentation")}>
              Documentation
            </Button>
          </div>
        )}
        {onDelete && (
          <Button variant="outline" className="w-full inspector-delete-trigger" onClick={onDelete}>
            <Trash2 size={14} /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function DetailNavigation({
  sections,
  active,
  onSelect,
}: {
  sections: { id: DetailSection; label: string }[];
  active: DetailSection;
  onSelect?: (section: DetailSection) => void;
}) {
  return (
    <nav className="detail-navigation" aria-label="Detail sections">
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-current={active === section.id ? "page" : undefined}
          onClick={() => onSelect?.(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

function EntityDetailContent({
  entity,
  graph,
  canvasId,
  section,
  onSelect,
}: {
  entity: ArchitectureEntity;
  graph: CanvasGraph;
  canvasId: string;
  section: DetailSection;
  onSelect?: (section: DetailSection) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <div className="detail-page">
      <div className="detail-page-intro">
        <Badge>{entityLabels[entity.type]}</Badge>
        <h2>{entity.name || "New node"}</h2>
        <p>{entity.description || "No description yet."}</p>
      </div>
      <DetailNavigation
        sections={[
          { id: "overview", label: "Overview" },
          { id: "documentation", label: "Documentation" },
          ...(entity.type === "database" ? [{ id: "schema" as const, label: "Database schema" }] : []),
        ]}
        active={section}
        onSelect={onSelect}
      />
      <div className="detail-page-grid">
        <div className="detail-page-secondary">
          {section === "overview" && (
            <section className="rich-detail-card">
              <div className="rich-detail-heading">
                <div>
                  <h3>About this {entity.type}</h3>
                  <p>Architecture context for this component.</p>
                </div>
              </div>
              <p className="detail-overview-description">
                {entity.description || "Add a description from Edit settings in the inspector."}
              </p>
              <dl className="detail-facts">
                <div>
                  <dt>Type</dt>
                  <dd>{entityLabels[entity.type]}</dd>
                </div>
                {entity.metadata.status && (
                  <div>
                    <dt>Status</dt>
                    <dd>{entity.metadata.status}</dd>
                  </div>
                )}
                {entity.metadata.engine && (
                  <div>
                    <dt>Engine</dt>
                    <dd>{entity.metadata.engine}</dd>
                  </div>
                )}
                {entity.metadata.technologyStack?.length ? (
                  <div>
                    <dt>Technology</dt>
                    <dd>{entity.metadata.technologyStack.join(", ")}</dd>
                  </div>
                ) : null}
                {entity.type === "system" && (
                  <div>
                    <dt>Direct components</dt>
                    <dd>{graph.placements.filter((placement) => placement.parentEntityId === entity.id).length}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
          {section === "schema" && entity.type === "database" && (
            <DatabaseSchema
              value={entity.metadata.schemaSql ?? ""}
              onSave={async (value) => {
                await api.updateEntity(entity.id, { metadata: { schemaSql: value || null } });
                await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
              }}
            />
          )}
          {section === "documentation" && (
            <RichDocumentation
              value={entity.metadata.documentation ?? ""}
              onSave={async (value) => {
                await api.updateEntity(entity.id, { metadata: { documentation: value || null } });
                await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionDetailContent({
  connection,
  entities,
  canvasId,
  section,
  onSelect,
}: {
  connection: ArchitectureConnection;
  entities: Map<string, ArchitectureEntity>;
  canvasId: string;
  section: DetailSection;
  onSelect?: (section: DetailSection) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <div className="detail-page">
      <div className="detail-page-intro">
        <Badge>{connection.type.toUpperCase()}</Badge>
        <h2>{connectionTitle(connection)}</h2>
        <p>
          {entities.get(connection.sourceEntityId)?.name ?? "Source"} →{" "}
          {entities.get(connection.targetEntityId)?.name ?? "Target"}
        </p>
      </div>
      <DetailNavigation
        sections={[
          { id: "overview", label: "Overview" },
          { id: "contract", label: "Contract" },
          { id: "documentation", label: "Documentation" },
        ]}
        active={section}
        onSelect={onSelect}
      />
      <div className="detail-page-grid">
        <div className="detail-page-secondary">
          {section === "overview" && (
            <section className="rich-detail-card">
              <div className="rich-detail-heading">
                <div>
                  <h3>Connection overview</h3>
                  <p>How these components communicate.</p>
                </div>
              </div>
              <p className="detail-overview-description">
                {connection.description || "Add a description from Edit settings in the inspector."}
              </p>
              <dl className="detail-facts">
                <div>
                  <dt>Protocol</dt>
                  <dd>{connection.type.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{entities.get(connection.sourceEntityId)?.name ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{entities.get(connection.targetEntityId)?.name ?? "Unknown"}</dd>
                </div>
                {connection.metadata.contract && (
                  <div>
                    <dt>Reference</dt>
                    <dd>{connection.metadata.contract}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
          {section === "contract" && (
            <ContractEditor
              value={connection.metadata.contractBody ?? ""}
              kind={connection.type}
              onSave={async (value) => {
                await api.updateConnection(connection.id, { metadata: { contractBody: value || null } });
                await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
              }}
            />
          )}
          {section === "documentation" && (
            <RichDocumentation
              value={connection.metadata.documentation ?? ""}
              onSave={async (value) => {
                await api.updateConnection(connection.id, { metadata: { documentation: value || null } });
                await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyInspector() {
  return (
    <div className="inspector-empty">
      <div className="inspector-empty-icon">
        <Layers3 size={19} />
      </div>
      <div className="inspector-empty-title">Select an item</div>
      <p>Details appear here.</p>
    </div>
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-section">
      <div className="inspector-section-head">
        <span>{title}</span>
        {trailing && <span className="text-muted-foreground normal-case tracking-normal">{trailing}</span>}
      </div>
      {children}
    </section>
  );
}
function ExternalValue({ label, value }: { label: string; value?: string }) {
  let href: string | null = null;
  if (value) {
    try {
      const candidate = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") href = candidate.href;
    } catch {
      href = null;
    }
  }
  return (
    <div className="external-value">
      <span>{label}</span>
      {value && href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {value}
          <ExternalLink size={11} />
        </a>
      ) : value ? (
        <span>{value}</span>
      ) : (
        <span className="placeholder-text">Not configured</span>
      )}
    </div>
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "recently"
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}
