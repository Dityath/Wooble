import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import { Database, KeyRound, Link2 } from "lucide-react";
import { Button } from "../../components/ui";

import { parseDatabaseSql, type Table } from "./database-schema-parser";

function TableNode({ data }: NodeProps<Node<{ table: Table }>>) {
  return (
    <div className="schema-table">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="schema-table-title">
        <Database size={15} /> {data.table.name}
      </div>
      {data.table.columns.map((column) => (
        <div className="schema-column" key={column.name}>
          <span>
            {column.primary ? <KeyRound size={12} /> : column.references ? <Link2 size={12} /> : null}
            {column.name}
          </span>
          <small>{column.type}</small>
        </div>
      ))}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { table: TableNode };
export function DatabaseSchema({ value, onSave }: { value: string; onSave?: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const previousValue = useRef(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft((current) => (current === previousValue.current ? value : current));
    previousValue.current = value;
  }, [value]);
  const schema = useMemo(() => parseDatabaseSql(draft), [draft]);
  const nodes = useMemo(
    () =>
      schema.tables.map(
        (table, index): Node<{ table: Table }> => ({
          id: table.name,
          type: "table",
          position: { x: (index % 3) * 285, y: Math.floor(index / 3) * 260 },
          data: { table },
          draggable: false,
        }),
      ),
    [schema],
  );
  const edges = useMemo(
    () =>
      schema.relations
        .filter((relation) => schema.tables.some((table) => table.name === relation.to))
        .map(
          (relation, index): Edge => ({
            id: `${relation.from}-${relation.to}-${index}`,
            source: relation.from,
            target: relation.to,
            label: relation.column,
            type: "smoothstep",
            animated: false,
          }),
        ),
    [schema],
  );
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave?.(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save schema");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="rich-detail-card">
      <div className="rich-detail-heading">
        <div>
          <h3>Database schema</h3>
          <p>
            {onSave
              ? "Write CREATE TABLE statements. Foreign keys become relationships in the diagram."
              : "Tables and foreign key relationships from the saved SQL schema."}
          </p>
        </div>
        {onSave && (
          <Button size="sm" onClick={() => void save()} disabled={saving || draft === value}>
            {saving ? "Saving…" : "Save schema"}
          </Button>
        )}
      </div>
      <div className="schema-editor-grid">
        <div className="schema-source">
          <label htmlFor="schema-sql">SQL schema</label>
          <textarea
            id="schema-sql"
            data-inline-editing={onSave ? "true" : undefined}
            readOnly={!onSave}
            aria-label="SQL schema"
            className="rich-source-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && onSave) {
                event.preventDefault();
                event.stopPropagation();
                setDraft(value);
                event.currentTarget.blur();
              }
            }}
            placeholder={"CREATE TABLE users (\n  id UUID PRIMARY KEY,\n  name VARCHAR(100)\n);"}
            maxLength={100000}
            spellCheck={false}
          />
          <small>
            {schema.tables.length} tables · {schema.relations.length} relationships
          </small>
        </div>
        <div className="schema-diagram" role="img" aria-label="Database relationship diagram">
          {nodes.length ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.24 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnScroll
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            </ReactFlow>
          ) : (
            <div className="rich-empty">Add CREATE TABLE statements to see a relationship diagram.</div>
          )}
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
