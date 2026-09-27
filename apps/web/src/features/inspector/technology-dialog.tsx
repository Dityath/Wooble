import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import type { ArchitectureEntity } from "@wooble/domain";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui";
import { api } from "../../lib/api";
import catalog from "./technology-catalog.json";
import { technologyGroupsByType, technologyItemsForGroup } from "./technology-groups";
import { TechnologyName } from "./technology-icon";

function initialSelection(entity: ArchitectureEntity) {
  if (entity.metadata.technologyStack) return new Set(entity.metadata.technologyStack);
  const legacy = [
    entity.metadata.language,
    entity.metadata.framework,
    entity.metadata.engine,
    entity.metadata.technology,
    ...(entity.metadata.interfaces ?? []),
  ].filter((value): value is string => Boolean(value));
  return new Set(
    catalog
      .filter((item) => legacy.some((value) => value.toLowerCase() === item.label.toLowerCase()))
      .map((item) => item.id),
  );
}

export function TechnologyDialog({
  entity,
  canvasId,
  open,
  onOpenChange,
}: {
  entity: ArchitectureEntity;
  canvasId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => initialSelection(entity));
  const [versions, setVersions] = useState<Record<string, string>>(() => entity.metadata.technologyVersions ?? {});
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = technologyGroupsByType[entity.type];
  const allowedIds = new Set(groups.flatMap((group) => technologyItemsForGroup(group).map((item) => item.id)));
  const previousItems = catalog.filter((item) => selected.has(item.id) && !allowedIds.has(item.id));
  const visibleGroups = [
    ...groups.map((group) => ({ label: group.label, items: technologyItemsForGroup(group) })),
    ...(previousItems.length ? [{ label: "Previously selected", items: previousItems }] : []),
  ];
  const chosen = visibleGroups.flatMap((group) => group.items).filter((item) => selected.has(item.id));
  const first = (category: string) => chosen.find((item) => item.category === category)?.label ?? null;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateEntity(entity.id, {
        metadata: {
          technologyStack: chosen.map((item) => item.id),
          technologyVersions: Object.fromEntries(
            chosen.map((item) => [item.id, versions[item.id]?.trim() ?? ""]).filter(([, version]) => version),
          ),
          language: first("Languages"),
          framework:
            entity.type === "frontend"
              ? (first("Frontend") ?? first("Backend"))
              : (first("Backend") ?? first("Frontend")),
          engine: entity.type === "database" ? first("Databases") : undefined,
          technology:
            first("Hardware") ??
            first("Sensors") ??
            first("Connectivity") ??
            first("Protocols") ??
            first("Messaging") ??
            first("Infrastructure"),
          // Keep the legacy API interface summary for existing node views.
          interfaces: chosen
            .filter((item) => item.category === "Protocols" && item.id !== "mqtt")
            .map((item) => item.label),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save technology");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="technology-dialog" aria-describedby="technology-dialog-description">
        <header className="technology-dialog-header">
          <DialogTitle>Technology stack</DialogTitle>
          <DialogDescription id="technology-dialog-description">
            Select the technologies used by {entity.name || "this node"}, then enter their versions.
          </DialogDescription>
        </header>
        <div className="technology-dialog-body">
          <div className="technology-picker">
            <label className="technology-search">
              <Search size={17} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search technologies"
              />
            </label>
            <div className="technology-dialog-list">
              {visibleGroups.map((group) => {
                const items = group.items.filter((item) =>
                  item.label.toLowerCase().includes(search.trim().toLowerCase()),
                );
                if (!items.length) return null;
                return (
                  <section key={group.label} className="technology-category">
                    <h3>{group.label}</h3>
                    <div className="technology-options">
                      {items.map((item) => (
                        <label
                          key={item.id}
                          className={`technology-option ${selected.has(item.id) ? "is-selected" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(item.id);
                                else next.delete(item.id);
                                return next;
                              })
                            }
                          />
                          <TechnologyName id={item.id} label={item.label} />
                          {selected.has(item.id) && <Check size={16} aria-hidden="true" />}
                        </label>
                      ))}
                    </div>
                  </section>
                );
              })}
              {search &&
                !visibleGroups.some((group) =>
                  group.items.some((item) => item.label.toLowerCase().includes(search.trim().toLowerCase())),
                ) && <p className="placeholder-line">No matching technologies in the catalog.</p>}
            </div>
          </div>
          <aside className="technology-selection" aria-label="Selected technologies and versions">
            <h3>Selected ({chosen.length})</h3>
            {chosen.length ? (
              chosen.map((item) => (
                <div className="technology-selected-item" key={item.id}>
                  <label htmlFor={`version-${item.id}`}>
                    <TechnologyName id={item.id} label={item.label} />
                  </label>
                  <input
                    id={`version-${item.id}`}
                    value={versions[item.id] ?? ""}
                    maxLength={50}
                    onChange={(event) => setVersions((current) => ({ ...current, [item.id]: event.target.value }))}
                    placeholder="Version (optional)"
                    aria-label={`${item.label} version`}
                  />
                </div>
              ))
            ) : (
              <p>Select a technology to set its version.</p>
            )}
          </aside>
        </div>
        <footer className="technology-dialog-footer">
          <span>{chosen.length} selected</span>
          {error && (
            <span role="alert" className="form-error">
              {error}
            </span>
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save technology"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
