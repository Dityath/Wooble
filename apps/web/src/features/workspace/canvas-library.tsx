import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowUpRight, Boxes, Clock3, Layers3, Plus, Search, Server, Waypoints, X } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Textarea,
} from "../../components/ui";
import { api } from "../../lib/api";

export function CanvasLibraryPage() {
  const { workspaceId: selectedId } = useSearch({ from: "/canvases" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canvasesQuery = useQuery({ queryKey: ["canvases"], queryFn: api.canvases });
  const workspacesQuery = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const createMutation = useMutation({
    mutationFn: api.createCanvas,
    onSuccess: async (canvas) => {
      await queryClient.invalidateQueries({ queryKey: ["canvases"] });
      setDialogOpen(false);
      setName("");
      setDescription("");
      await navigate({ to: "/canvases/$canvasId", params: { canvasId: canvas.id } });
    },
  });
  const workspace =
    workspacesQuery.data?.find((item) => item.id === selectedId) ??
    workspacesQuery.data?.find((item) => item.role === "manager") ??
    workspacesQuery.data?.[0];
  useEffect(() => {
    if (workspacesQuery.isSuccess && workspacesQuery.data.length === 0) void navigate({ to: "/no-workspace" });
  }, [workspacesQuery.isSuccess, workspacesQuery.data, navigate]);
  const canCreate = workspace?.role === "manager";
  const canvases = (canvasesQuery.data ?? []).filter((canvas) => canvas.workspaceId === workspace?.id);
  const matchingCanvases = canvases
    .filter((canvas) =>
      `${canvas.name} ${canvas.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );

  return (
    <AppShell workspaceId={workspace?.id}>
      <div className="library-page">
        <div className="library-heading-row">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-dot" /> WORKSPACE
            </div>
            <h1>Your canvases</h1>
            <p className="library-workspace-name">
              {workspace
                ? `View and manage the maps in ${workspace.name}.`
                : "Create a workspace to start mapping your systems."}
            </p>
          </div>
          {canCreate && canvases.length > 0 && (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus size={15} /> New canvas
            </Button>
          )}
        </div>
        {workspacesQuery.isPending || canvasesQuery.isPending ? (
          <div className="canvas-card-grid">
            {[1, 2, 3].map((item) => (
              <div key={item} className="canvas-card-skeleton" />
            ))}
          </div>
        ) : canvasesQuery.isError ? (
          <div className="load-error">
            <div className="load-error-icon">!</div>
            <h2>Canvases unavailable</h2>
            <p>{canvasesQuery.error.message}</p>
            <Button variant="secondary" onClick={() => void canvasesQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : !workspace ? (
          <div className="empty-library">
            <img src="/wooble-empty-canvas.png" alt="" className="empty-state-art" />
            <h2>No workspace access</h2>
            <p>Ask a workspace manager for an invitation link, or create your own workspace.</p>
            <Link to="/workspaces/new" className="action-link">
              Create workspace
            </Link>
          </div>
        ) : canvases.length === 0 ? (
          <div className="empty-library">
            <img src="/wooble-empty-canvas.png" alt="" className="empty-state-art" />
            <h2>{canCreate ? "Start with a canvas" : "No canvases shared yet"}</h2>
            <p>
              {canCreate
                ? "Map systems and their connections."
                : "A workspace manager can give you viewer or editor access."}
            </p>
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus size={15} /> New canvas
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="library-section-head">
              <div>
                <h2>
                  All canvases <span>{canvases.length}</span>
                </h2>
              </div>
              <div className="library-controls">
                <div className="library-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    aria-label="Search canvases"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search canvases"
                  />
                  {search && (
                    <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                      <X size={15} />
                    </button>
                  )}
                </div>
                <label className="library-sort">
                  <Clock3 size={15} aria-hidden="true" />
                  <span className="sr-only">Sort canvases</span>
                  <select value={sort} onChange={(event) => setSort(event.target.value as "recent" | "name")}>
                    <option value="recent">Recently updated</option>
                    <option value="name">Name A–Z</option>
                  </select>
                </label>
              </div>
            </div>
            {matchingCanvases.length === 0 ? (
              <div className="library-no-results">
                <Search size={22} />
                <h3>No matching canvases</h3>
                <p>Try another name or description.</p>
                <Button variant="secondary" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              </div>
            ) : (
              <div className="canvas-card-grid">
                {matchingCanvases.map((canvas, index) => (
                  <CanvasCard key={canvas.id} canvas={canvas} index={index} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <div className="dialog-mark">
            <Waypoints size={19} />
          </div>
          <DialogTitle>New canvas</DialogTitle>
          <DialogDescription>Give this canvas a name your team will recognize.</DialogDescription>
          <form
            className="canvas-form"
            onSubmit={(event) => {
              event.preventDefault();
              const workspaceId = workspace?.id;
              if (workspaceId && name.trim())
                createMutation.mutate({ workspaceId, name: name.trim(), description: description.trim() });
            }}
          >
            <div className="canvas-form-field">
              <label htmlFor="canvas-name">Canvas name</label>
              <Input
                id="canvas-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Payments Platform"
                required
                maxLength={100}
              />
            </div>
            <div className="canvas-form-field">
              <label htmlFor="canvas-description">
                Description <span className="form-optional">Optional</span>
              </label>
              <Textarea
                id="canvas-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Add a short note"
                rows={3}
                maxLength={500}
              />
            </div>
            {createMutation.isError && <p className="form-error">{createMutation.error.message}</p>}

            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || createMutation.isPending || !canCreate}>
                {createMutation.isPending ? "Creating…" : "Create canvas"}
                <ArrowUpRight size={14} />
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function CanvasCard({
  canvas,
  index,
}: {
  canvas: {
    id: string;
    name: string;
    description: string;
    systemCount: number;
    serviceCount: number;
    updatedAt: string;
  };
  index: number;
}) {
  return (
    <Link to="/canvases/$canvasId" params={{ canvasId: canvas.id }} className="canvas-card-link">
      <Card className={`canvas-card card-tone-${index % 3}`}>
        <div className="canvas-card-art" aria-hidden="true">
          <div className="card-art-grid" />
          <div className="card-art-line art-line-one" />
          <div className="card-art-line art-line-two" />
          <div className="card-art-line art-line-three" />
          <span className="art-node art-node-one">
            <Boxes size={14} />
          </span>
          <span className="art-node art-node-two">
            <Server size={13} />
          </span>
          <span className="art-node art-node-three">
            <Server size={13} />
          </span>
          <span className="art-node art-node-four">
            <Layers3 size={13} />
          </span>
          <span className="art-system-boundary" />
        </div>
        <div className="canvas-card-content">
          <div className="canvas-card-top">
            <span className="canvas-card-arrow">
              <ArrowUpRight size={15} />
            </span>
          </div>
          <h3>{canvas.name}</h3>
          <p>{canvas.description}</p>
          <div className="canvas-card-meta">
            <span>
              <Boxes size={13} />
              {canvas.systemCount} {canvas.systemCount === 1 ? "system" : "systems"}
            </span>
            <span>
              <Server size={13} />
              {canvas.serviceCount} {canvas.serviceCount === 1 ? "service" : "services"}
            </span>
            <span className="card-updated">{formatDate(canvas.updatedAt)}</span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recently"
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}
