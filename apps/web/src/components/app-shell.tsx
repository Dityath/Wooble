import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Layers3, LogOut, Menu, Plus, Settings2, Share2, UserRound, X } from "lucide-react";
import type { ArchitectureEntity } from "@wooble/domain";
import { CanvasShareDialog } from "../features/workspace/canvas-share-dialog";
import { EntityKindIcon } from "../features/canvas/architecture-nodes";
import { api, type CanvasGraph } from "../lib/api";
import { useAppearance } from "../lib/use-appearance";
import { Separator } from "./ui";

export function AppShell({
  children,
  canvasName,
  canvasId,
  workspaceId,
  systems = [],
  canvasZenMode = false,
  canvasGraph,
  onFocusEntity,
}: {
  children: React.ReactNode;
  canvasName?: string;
  canvasId?: string;
  workspaceId?: string;
  systems?: ArchitectureEntity[];
  canvasZenMode?: boolean;
  canvasGraph?: CanvasGraph;
  onFocusEntity?: (entityId: string) => void;
}) {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const me = meQuery.data;
  const guest = !!canvasId && !me;
  const { data: canvases = [] } = useQuery({
    queryKey: ["canvases"],
    queryFn: api.canvases,
    enabled: !!me && !canvasId,
  });
  const { data: workspaces = [] } = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: !!me });
  const { data: access } = useQuery({
    queryKey: ["canvas-access", canvasId],
    queryFn: () => (canvasId ? api.canvasAccess(canvasId) : Promise.reject(new Error("Canvas ID is required"))),
    enabled: !!canvasId,
  });
  const { data: guestGraph } = useQuery({
    queryKey: ["canvas-graph", canvasId],
    queryFn: () => api.graph(canvasId ?? ""),
    enabled: guest && !!canvasId && systems.length === 0,
  });
  const visibleSystems = systems.length
    ? systems
    : (guestGraph?.entities.filter((entity) => entity.type === "system") ?? []);
  const visibleGraph = canvasGraph ?? guestGraph;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [openMenu, setOpenMenu] = useState<"workspace" | "account" | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  useAppearance();
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const closeOutside = (event: PointerEvent) => {
      const menu = openMenu === "workspace" ? workspaceMenuRef.current : accountMenuRef.current;
      if (!menu?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = openMenu === "workspace" ? workspaceMenuRef.current : accountMenuRef.current;
      setOpenMenu(null);
      menu?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);
  useEffect(() => {
    if (!navigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);
  const outsideWorkspace = !!canvasId && !!workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId);
  const currentWorkspace = outsideWorkspace
    ? undefined
    : (workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.role === "manager") ??
      workspaces[0]);
  const currentCanvases = currentWorkspace
    ? canvases.filter((canvas) => canvas.workspaceId === currentWorkspace.id)
    : [];
  const closeNavigation = () => setNavigationOpen(false);
  const accountMenu = (
    <div className="account-menu" ref={accountMenuRef}>
      <button
        type="button"
        className="user-avatar"
        aria-label="Open account menu"
        aria-expanded={openMenu === "account"}
        aria-controls="account-menu-panel"
        onClick={() => setOpenMenu(openMenu === "account" ? null : "account")}
      >
        {me?.name.slice(0, 1).toUpperCase() ?? <UserRound size={15} />}
      </button>
      {openMenu === "account" && (
        <div id="account-menu-panel" className="account-menu-panel">
          <div className="account-menu-identity">
            <strong>{me?.name ?? "Your account"}</strong>
            <span>{me?.email}</span>
          </div>
          {me?.systemRole === "admin" && (
            <Link to="/admin/users" className="account-menu-item" onClick={() => setOpenMenu(null)}>
              <Settings2 size={16} /> System admin
            </Link>
          )}
          <Link to="/profile" className="account-menu-item" onClick={() => setOpenMenu(null)}>
            <UserRound size={16} /> Profile
          </Link>
          <button
            type="button"
            className="account-menu-item account-menu-signout"
            disabled={signOutBusy}
            onClick={async () => {
              setSignOutBusy(true);
              setSignOutError("");
              try {
                await api.logout();
                queryClient.clear();
                setOpenMenu(null);
                await navigate({ to: "/login" });
              } catch (error) {
                setSignOutError(error instanceof Error ? error.message : "Could not sign out. Try again.");
              } finally {
                setSignOutBusy(false);
              }
            }}
          >
            <LogOut size={16} /> {signOutBusy ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && (
            <p className="account-menu-error" role="alert">
              {signOutError}
            </p>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div className={`app-shell${canvasId ? " canvas-mode" : ""}${canvasZenMode ? " canvas-zen-mode" : ""}`}>
      <header className="app-topbar">
        <button
          type="button"
          className="mobile-nav-trigger"
          aria-label={navigationOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navigationOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavigationOpen(!navigationOpen)}
        >
          {navigationOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        {guest ? (
          <div className="brand-block">
            <img className="brand-mark" src="/wooble-mark.svg" alt="" />
            <span className="brand-name">wooble</span>
          </div>
        ) : (
          <Link
            to="/canvases"
            className="brand-block"
            aria-label="Wooble architecture library"
            onClick={closeNavigation}
          >
            <img className="brand-mark" src="/wooble-mark.svg" alt="" />
            <span className="brand-name">wooble</span>
          </Link>
        )}
        <Separator orientation="vertical" className="top-separator" />
        <nav className="topbar-context" aria-label="Current location">
          {guest ? (
            <span>Shared canvas</span>
          ) : currentWorkspace ? (
            <Link to="/canvases" search={{ workspaceId: currentWorkspace.id }} onClick={closeNavigation}>
              {currentWorkspace.name}
            </Link>
          ) : (
            <span>{outsideWorkspace ? "Shared canvas" : "Workspace"}</span>
          )}
          {canvasName && (
            <>
              <span className="topbar-context-separator">/</span>
              <strong>{canvasName}</strong>
            </>
          )}
        </nav>
        <div className="topbar-actions">
          {canvasId && access?.role === "manager" && (
            <>
              <button
                type="button"
                className="top-action-link"
                aria-label="Share canvas"
                title="Share"
                onClick={() => setShareOpen(true)}
              >
                <Share2 size={16} />
              </button>
              <Link
                to="/canvases/$canvasId/manage"
                params={{ canvasId }}
                className="top-action-link"
                aria-label="Manage canvas"
                title="Manage"
              >
                <Settings2 size={16} />
              </Link>
            </>
          )}
          {guest ? (
            <Link
              to="/login"
              search={{ returnTo: `${window.location.pathname}${window.location.search}` }}
              className="top-action-link guest-login-link"
            >
              Sign in to Wooble
            </Link>
          ) : (
            accountMenu
          )}
        </div>
      </header>
      <div className="app-frame">
        {navigationOpen && (
          <button type="button" className="sidebar-scrim" aria-label="Close navigation" onClick={closeNavigation} />
        )}
        <aside id="app-sidebar" className={`sidebar${navigationOpen ? " sidebar-open" : ""}`}>
          {guest ? (
            <>
              <div className="sidebar-heading system-heading">
                <span>SYSTEMS</span>
                <span className="sidebar-count">{visibleSystems.length}</span>
              </div>
              <SystemTree systems={visibleSystems} graph={visibleGraph} onFocusEntity={onFocusEntity} />
            </>
          ) : (
            <>
              <div className="workspace-menu" ref={workspaceMenuRef}>
                <button
                  type="button"
                  className="sidebar-workspace"
                  aria-label="Choose workspace"
                  aria-expanded={openMenu === "workspace"}
                  aria-controls="workspace-menu-panel"
                  onClick={() => setOpenMenu(openMenu === "workspace" ? null : "workspace")}
                >
                  <span className="workspace-avatar small">
                    {currentWorkspace?.name.slice(0, 1).toUpperCase() ?? (outsideWorkspace ? "S" : "W")}
                  </span>
                  <span className="workspace-menu-label">
                    <span className="workspace-name">
                      {currentWorkspace?.name ?? (outsideWorkspace ? "Shared canvas" : "No workspace")}
                    </span>
                    <span className="workspace-plan">{outsideWorkspace ? "Viewer access" : "Workspace"}</span>
                  </span>
                  <ChevronDown className="workspace-menu-chevron" size={16} />
                </button>
                {openMenu === "workspace" && (
                  <div id="workspace-menu-panel" className="workspace-menu-panel">
                    <div className="workspace-menu-title">Your workspaces</div>
                    {workspaces.map((workspace) => (
                      <Link
                        key={workspace.id}
                        to="/canvases"
                        search={{ workspaceId: workspace.id }}
                        className="workspace-menu-item"
                        onClick={() => {
                          setOpenMenu(null);
                          closeNavigation();
                        }}
                      >
                        <span className="workspace-avatar small">{workspace.name.slice(0, 1).toUpperCase()}</span>
                        <span>{workspace.name}</span>
                        {workspace.id === currentWorkspace?.id && (
                          <span className="workspace-menu-current">Current</span>
                        )}
                      </Link>
                    ))}
                    <Link
                      to="/workspaces/new"
                      className="workspace-menu-item workspace-menu-create"
                      onClick={() => {
                        setOpenMenu(null);
                        closeNavigation();
                      }}
                    >
                      <Plus size={16} /> Create workspace
                    </Link>
                  </div>
                )}
              </div>
              {!canvasId && (
                <>
                  <div className="sidebar-section-label">WORKSPACE</div>
                  <Link
                    to="/canvases"
                    search={currentWorkspace ? { workspaceId: currentWorkspace.id } : {}}
                    className="sidebar-link"
                    activeProps={{ className: "sidebar-link active" }}
                    onClick={closeNavigation}
                  >
                    <Layers3 size={16} /> Canvases
                  </Link>
                  {currentWorkspace?.role === "manager" && (
                    <Link
                      to="/workspaces/$workspaceId/settings"
                      params={{ workspaceId: currentWorkspace.id }}
                      className="sidebar-link"
                      activeProps={{ className: "sidebar-link active" }}
                      onClick={closeNavigation}
                    >
                      <Settings2 size={16} /> Manage workspace
                    </Link>
                  )}
                  {currentCanvases.length > 0 && <div className="sidebar-heading">RECENT CANVASES</div>}
                  <nav className="canvas-nav" aria-label="Recent canvases">
                    {currentCanvases.map((canvas) => (
                      <Link
                        key={canvas.id}
                        to="/canvases/$canvasId"
                        params={{ canvasId: canvas.id }}
                        className="sidebar-link canvas-nav-link"
                        activeProps={{ className: "sidebar-link canvas-nav-link active" }}
                        onClick={closeNavigation}
                      >
                        <span className="canvas-nav-dot" />
                        {canvas.name}
                      </Link>
                    ))}
                  </nav>
                </>
              )}
              {canvasName && systems.length > 0 && (
                <>
                  <div className="sidebar-heading system-heading">
                    <span>SYSTEMS</span>
                    <span className="sidebar-count">{systems.length}</span>
                  </div>
                  <SystemTree systems={systems} graph={visibleGraph} onFocusEntity={onFocusEntity} />
                </>
              )}
            </>
          )}
        </aside>
        <main className="app-main">{children}</main>
      </div>
      {canvasId && access?.role === "manager" && (
        <CanvasShareDialog canvasId={canvasId} open={shareOpen} onOpenChange={setShareOpen} />
      )}
    </div>
  );
}

function SystemTree({
  systems,
  graph,
  onFocusEntity,
}: {
  systems: ArchitectureEntity[];
  graph?: CanvasGraph;
  onFocusEntity?: (entityId: string) => void;
}) {
  const entities = new Map(graph?.entities.map((entity) => [entity.id, entity]) ?? []);
  const children = new Map<string, ArchitectureEntity[]>();
  for (const placement of graph?.placements ?? []) {
    if (!placement.parentEntityId) continue;
    const entity = entities.get(placement.entityId);
    if (entity) children.set(placement.parentEntityId, [...(children.get(placement.parentEntityId) ?? []), entity]);
  }
  const nestedSystems = new Set(
    graph?.placements.filter((placement) => placement.parentEntityId).map((placement) => placement.entityId) ?? [],
  );
  return (
    <nav className="system-nav" aria-label="System hierarchy">
      {systems
        .filter((system) => !nestedSystems.has(system.id))
        .map((system) => (
          <SystemTreeItem
            key={system.id}
            entity={system}
            childrenById={children}
            depth={0}
            ancestry={new Set()}
            onFocusEntity={onFocusEntity}
          />
        ))}
    </nav>
  );
}

function SystemTreeItem({
  entity,
  childrenById,
  depth,
  ancestry,
  onFocusEntity,
}: {
  entity: ArchitectureEntity;
  childrenById: Map<string, ArchitectureEntity[]>;
  depth: number;
  ancestry: Set<string>;
  onFocusEntity?: (entityId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const children = (childrenById.get(entity.id) ?? []).filter(
    (child) => !ancestry.has(child.id) && child.id !== entity.id,
  );
  const nextAncestry = new Set([...ancestry, entity.id]);
  return (
    <div className="system-tree-group">
      <div className="system-tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
        <button
          type="button"
          className="system-tree-toggle"
          aria-label={`${open ? "Collapse" : "Expand"} ${entity.name}`}
          aria-expanded={open}
          disabled={!children.length}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="system-tree-label"
          onClick={() => {
            if (children.length) setOpen(!open);
            onFocusEntity?.(entity.id);
          }}
        >
          <span className="system-nav-icon">
            <EntityKindIcon type={entity.type} size={13} />
          </span>
          <span>{entity.name || "New node"}</span>
        </button>
      </div>
      {open &&
        children.map((child) => (
          <SystemTreeItem
            key={child.id}
            entity={child}
            childrenById={childrenById}
            depth={depth + 1}
            ancestry={nextAncestry}
            onFocusEntity={onFocusEntity}
          />
        ))}
    </div>
  );
}
