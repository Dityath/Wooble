import { useEffect, useMemo, useRef, useState } from "react";
import { parse as parseYaml } from "yaml";
import { FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui";

type Operation = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  parameters?: string[];
  responses?: { status: string; description: string }[];
};
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
function parseOpenApi(value: string): { title: string; version: string; operations: Operation[] } | null {
  try {
    const data = (value.trim().startsWith("{") ? JSON.parse(value) : parseYaml(value)) as Record<string, unknown>;
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.openapi !== "string" ||
      typeof data.paths !== "object" ||
      !data.paths
    )
      return null;
    const info = data.info as Record<string, unknown> | undefined;
    const operations: Operation[] = [];
    for (const [path, pathItem] of Object.entries(data.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.includes(method.toUpperCase()) || !operation || typeof operation !== "object") continue;
        operations.push({
          id: crypto.randomUUID(),
          path,
          method: method.toUpperCase(),
          summary: String((operation as Record<string, unknown>).summary ?? ""),
          description: String((operation as Record<string, unknown>).description ?? ""),
          parameters: Array.isArray((operation as Record<string, unknown>).parameters)
            ? ((operation as Record<string, unknown>).parameters as Record<string, unknown>[]).map(
                (parameter) => `${parameter.name ?? "Parameter"} · ${parameter.in ?? "query"}`,
              )
            : [],
          responses: Object.entries(
            ((operation as Record<string, unknown>).responses ?? {}) as Record<string, { description?: string }>,
          ).map(([status, response]) => ({ status, description: response?.description ?? "" })),
        });
      }
    }
    return {
      title: typeof info?.title === "string" ? info.title : "API",
      version: typeof info?.version === "string" ? info.version : "1.0.0",
      operations,
    };
  } catch {
    return null;
  }
}
function generateOpenApi(title: string, version: string, operations: Operation[], source: string) {
  let base: Record<string, unknown> = {};
  try {
    const parsed = source.trim().startsWith("{") ? JSON.parse(source) : parseYaml(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    /* A new visual contract starts with an empty document. */
  }
  const oldPaths =
    base.paths && typeof base.paths === "object" ? (base.paths as Record<string, Record<string, unknown>>) : {};
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    if (!operation.path.trim()) continue;
    const path = operation.path.startsWith("/") ? operation.path : `/${operation.path}`;
    paths[path] ??= {};
    const original = oldPaths[path]?.[operation.method.toLowerCase()];
    paths[path][operation.method.toLowerCase()] = {
      ...(original && typeof original === "object"
        ? original
        : { responses: { "200": { description: "Successful response" } } }),
      summary: operation.summary,
    };
  }
  return JSON.stringify(
    {
      ...base,
      openapi: base.openapi ?? "3.1.0",
      info: {
        ...(base.info && typeof base.info === "object" ? base.info : {}),
        title: title || "API",
        version: version || "1.0.0",
      },
      paths,
    },
    null,
    2,
  );
}

export function ContractPreview({ value, kind }: { value: string; kind: string }) {
  const parsed = kind === "rest" ? parseOpenApi(value) : null;
  if (!parsed) return <pre className="contract-raw-preview">{value || "No contract yet."}</pre>;
  return (
    <div className="contract-preview">
      <div className="contract-info">
        <strong>{parsed.title}</strong>
        <span>OpenAPI {parsed.version}</span>
      </div>
      {parsed.operations.length ? (
        parsed.operations.map((operation) => (
          <details className="contract-operation-detail" key={`${operation.method}-${operation.path}`}>
            <summary className="contract-operation">
              <span className={`contract-method method-${operation.method.toLowerCase()}`}>{operation.method}</span>
              <code>{operation.path}</code>
              <span>{operation.summary}</span>
            </summary>
            <div className="contract-operation-body">
              {operation.description && <p>{operation.description}</p>}
              {operation.parameters?.length ? (
                <p>
                  <strong>Parameters</strong> {operation.parameters.join(", ")}
                </p>
              ) : null}
              {operation.responses?.length ? (
                <div>
                  <strong>Responses</strong>
                  {operation.responses.map((response) => (
                    <p key={response.status}>
                      <code>{response.status}</code> {response.description}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        ))
      ) : (
        <p className="rich-empty">No operations in this contract.</p>
      )}
    </div>
  );
}
export function ContractEditor({
  value,
  kind,
  onSave,
}: {
  value: string;
  kind: string;
  onSave: (value: string) => Promise<void>;
}) {
  const rest = kind === "rest";
  const [tab, setTab] = useState<"preview" | "gui" | "source">("preview");
  const [draft, setDraft] = useState(value);
  const previousValue = useRef(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (rest ? parseOpenApi(draft) : null), [draft, rest]);
  const [title, setTitle] = useState(parsed?.title ?? "API");
  const [version, setVersion] = useState(parsed?.version ?? "1.0.0");
  const [operations, setOperations] = useState<Operation[]>(parsed?.operations ?? []);
  useEffect(() => {
    setDraft((current) => (current === previousValue.current ? value : current));
    previousValue.current = value;
  }, [value]);
  const showGui = () => {
    const next = parseOpenApi(draft);
    if (next) {
      setTitle(next.title);
      setVersion(next.version);
      setOperations(next.operations);
    }
    setTab("gui");
  };
  const save = async (body: string) => {
    setSaving(true);
    setError("");
    try {
      await onSave(body);
      setDraft(body);
      setTab("preview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save contract");
    } finally {
      setSaving(false);
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 100000) {
      setError("OpenAPI file must be under 100 KB");
      return;
    }
    const body = await file.text();
    if (!parseOpenApi(body)) {
      setError("Import a valid OpenAPI 3 JSON or YAML document");
      return;
    }
    setDraft(body);
    setError("");
    setTab("source");
  };
  return (
    <section className="rich-detail-card">
      <div className="rich-detail-heading">
        <div>
          <h3>{rest ? "API contract" : "Connection contract"}</h3>
          <p>
            {rest
              ? "Explore endpoints, edit visually, or import OpenAPI JSON/YAML."
              : "Write the protocol or contract definition."}
          </p>
        </div>
        {rest && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.yaml,.yml,application/json,text/yaml"
              hidden
              onChange={(event) => void importFile(event.target.files?.[0])}
            />
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
              <FileUp size={14} /> Import
            </Button>
          </>
        )}
      </div>
      <div className="rich-tabs" role="tablist" aria-label="Contract view">
        <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
          Preview
        </button>
        {rest && (
          <button type="button" role="tab" aria-selected={tab === "gui"} onClick={showGui}>
            Visual editor
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "source"} onClick={() => setTab("source")}>
          Source
        </button>
      </div>
      {tab === "preview" && <ContractPreview value={draft} kind={kind} />}
      {tab === "source" && (
        <div className="contract-source">
          <textarea
            data-inline-editing="true"
            aria-label="Contract source"
            className="rich-source-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(value);
                setTab("preview");
              }
            }}
            maxLength={100000}
            spellCheck={false}
            placeholder={rest ? "Paste OpenAPI JSON or YAML…" : "Paste Proto, SQL, or contract notes…"}
          />
          <div className="rich-editor-footer">
            {rest && draft && !parsed && <span className="form-error">OpenAPI preview requires a valid document</span>}
            <Button size="sm" disabled={saving || draft === value} onClick={() => void save(draft)}>
              {saving ? "Saving…" : "Save source"}
            </Button>
          </div>
        </div>
      )}
      {tab === "gui" && (
        <div className="contract-gui">
          <div className="contract-gui-info">
            <label>
              Title
              <input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              Version
              <input value={version} maxLength={30} onChange={(event) => setVersion(event.target.value)} />
            </label>
          </div>
          {operations.map((operation, index) => (
            <div className="contract-gui-row" key={operation.id}>
              <select
                aria-label={`Method ${index + 1}`}
                value={operation.method}
                onChange={(event) =>
                  setOperations((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, method: event.target.value } : item,
                    ),
                  )
                }
              >
                {methods.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
              <input
                aria-label={`Path ${index + 1}`}
                placeholder="/users"
                value={operation.path}
                onChange={(event) =>
                  setOperations((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, path: event.target.value } : item,
                    ),
                  )
                }
              />
              <input
                aria-label={`Summary ${index + 1}`}
                placeholder="Operation summary"
                value={operation.summary}
                onChange={(event) =>
                  setOperations((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, summary: event.target.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label={`Remove operation ${index + 1}`}
                onClick={() => setOperations((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <div className="rich-editor-footer">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setOperations((current) => [
                  ...current,
                  { id: crypto.randomUUID(), method: "GET", path: "", summary: "" },
                ])
              }
            >
              <Plus size={14} /> Add endpoint
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => void save(generateOpenApi(title, version, operations, draft))}
            >
              {saving ? "Saving…" : "Save contract"}
            </Button>
          </div>
          <p className="contract-gui-note">
            New endpoints receive a basic 200 response. Existing schemas, security, and examples stay in the source.
          </p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
