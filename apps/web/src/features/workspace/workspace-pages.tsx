import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { AppShell } from "../../components/app-shell";
import { PageIntro } from "../../components/page-intro";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../../components/ui";
import { api, type Member } from "../../lib/api";

function InviteLink({ create, label }: { create: () => Promise<{ token: string }>; label: string }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="invite-controls">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const { token } = await create();
            setLink(`${window.location.origin}/invite/${token}`);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not create link");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Link2 size={15} />
        {label}
      </Button>
      {link && (
        <div className="invite-link">
          <Input aria-label="Invitation link" value={link} readOnly onFocus={(event) => event.target.select()} />
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(link)}>
            Copy
          </Button>
          <small>One use · expires in 7 days</small>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
function Members({
  members,
  editable,
  roles,
  onUpdate,
  onRemove,
}: {
  members: Member[];
  editable: boolean;
  roles: string[];
  onUpdate: (userId: string, role: string) => Promise<unknown>;
  onRemove: (userId: string) => Promise<unknown>;
}) {
  const [error, setError] = useState("");
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me });
  return (
    <div className="member-list">
      {members.map((member) => (
        <div className="member-row" key={member.id}>
          <span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>
              {member.name} {member.id === me?.id && <span className="member-you">You</span>}
            </strong>
            <small>{member.email}</small>
          </div>
          {editable && member.id !== me?.id ? (
            <>
              <select
                aria-label={`Role for ${member.name}`}
                value={member.role}
                onChange={async (event) => {
                  try {
                    await onUpdate(member.id, event.target.value);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not update role");
                  }
                }}
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await onRemove(member.id);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not remove member");
                  }
                }}
              >
                Remove
              </Button>
            </>
          ) : (
            <span className="role-label">{member.role}</span>
          )}
        </div>
      ))}
      {!members.length && <p>No members yet.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}

function EditableDetailsCard({
  title,
  idPrefix,
  name,
  description,
  onSave,
}: {
  title: string;
  idPrefix: string;
  name: string;
  description: string;
  onSave: (input: { name: string; description: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const startEditing = () => {
    setDraftName(name);
    setDraftDescription(description);
    setError("");
    setEditing(true);
  };
  return (
    <Card className="management-card">
      <div className="management-card-heading">
        <h2>{title}</h2>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            <Pencil size={14} /> Edit
          </Button>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            setError("");
            try {
              await onSave({ name: draftName.trim(), description: draftDescription.trim() });
              setEditing(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not save changes");
            } finally {
              setSaving(false);
            }
          }}
        >
          <label htmlFor={`${idPrefix}-name`}>
            Name
            <Input
              id={`${idPrefix}-name`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label htmlFor={`${idPrefix}-description`}>
            Description
            <Textarea
              id={`${idPrefix}-description`}
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              maxLength={500}
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="details-edit-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !draftName.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="details-summary">
          <div>
            <dt>Name</dt>
            <dd>{name}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{description || "No description"}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
export function WorkspaceSettingsPage() {
  const { workspaceId } = useParams({ from: "/workspaces/$workspaceId/settings" });
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace", workspaceId], queryFn: () => api.workspace(workspaceId) });
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => api.workspaceMembers(workspaceId),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"manager" | "member">("member");
  const [message, setMessage] = useState("");
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
    ]);
  };
  return (
    <AppShell workspaceId={workspaceId}>
      <div className="management-page workspace-settings-page">
        <Link to="/canvases" search={{ workspaceId }} className="back-link">
          <ArrowLeft size={14} /> Canvases
        </Link>
        <PageIntro
          label="WORKSPACE SETTINGS"
          title={workspace.data?.name ?? "Manage workspace"}
          description="Update the workspace and its people."
        />
        {workspace.isError ? (
          <p role="alert">{workspace.error.message}</p>
        ) : (
          workspace.data?.role === "manager" && (
            <Tabs defaultValue="workspace" className="management-tabs">
              <TabsList className="management-tabs-list" aria-label="Workspace management sections">
                <TabsTrigger value="workspace" className="management-tab">
                  Workspace
                </TabsTrigger>
                <TabsTrigger value="people" className="management-tab">
                  People
                </TabsTrigger>
              </TabsList>
              <TabsContent value="workspace">
                <EditableDetailsCard
                  title="Workspace details"
                  idPrefix="workspace-edit"
                  name={workspace.data.name}
                  description={workspace.data.description}
                  onSave={async (input) => {
                    await api.updateWorkspace(workspaceId, input);
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] }),
                      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
                    ]);
                  }}
                />
              </TabsContent>
              <TabsContent value="people">
                <Card className="management-card">
                  <h2>People in workspace</h2>
                  <p>Members can see this workspace. Choose who can open each canvas separately.</p>
                  <form
                    className="inline-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      setMessage("");
                      try {
                        await api.addWorkspaceMember(workspaceId, email, role);
                        setEmail("");
                        await refresh();
                      } catch (cause) {
                        setMessage(cause instanceof Error ? cause.message : "Could not add member");
                      }
                    }}
                  >
                    <Input
                      type="email"
                      placeholder="Registered user's email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                    <select
                      aria-label="Workspace role"
                      value={role}
                      onChange={(event) => setRole(event.target.value as typeof role)}
                    >
                      <option value="member">Member</option>
                      <option value="manager">Manager</option>
                    </select>
                    <Button>
                      <Plus size={15} /> Add
                    </Button>
                  </form>
                  <Members
                    members={members.data ?? []}
                    editable
                    roles={["manager", "member"]}
                    onUpdate={async (id, next) => {
                      await api.updateWorkspaceMember(workspaceId, id, next as "manager" | "member");
                      await refresh();
                    }}
                    onRemove={async (id) => {
                      await api.removeWorkspaceMember(workspaceId, id);
                      await refresh();
                    }}
                  />
                </Card>
                <Card className="management-card">
                  <h2>Invite by link</h2>
                  <p>This link lets one person join the workspace. It expires in 7 days.</p>
                  <InviteLink create={() => api.inviteWorkspace(workspaceId)} label="Create workspace link" />
                </Card>
              </TabsContent>
            </Tabs>
          )
        )}
        {message && (
          <p role="status" className="management-message">
            {message}
          </p>
        )}
      </div>
    </AppShell>
  );
}
export function CanvasSettingsPage() {
  const { canvasId } = useParams({ from: "/canvases/$canvasId/manage" });
  const canvas = useQuery({ queryKey: ["canvas", canvasId], queryFn: () => api.canvas(canvasId) });
  const access = useQuery({ queryKey: ["canvas-access", canvasId], queryFn: () => api.canvasAccess(canvasId) });
  const members = useQuery({
    queryKey: ["canvas-members", canvasId],
    queryFn: () => api.canvasMembers(canvasId),
    enabled: access.data?.role === "manager",
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [linkRole, setLinkRole] = useState<"editor" | "viewer">("viewer");
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["canvas-members", canvasId] });
  };
  return (
    <AppShell workspaceId={canvas.data?.workspaceId}>
      <div className="management-page canvas-settings-page">
        <Link to="/canvases/$canvasId" params={{ canvasId }} className="back-link">
          <ArrowLeft size={14} /> Canvas
        </Link>
        <PageIntro
          label="CANVAS SETTINGS"
          title={canvas.data?.name ?? "Manage canvas"}
          description="Choose who can view or edit this canvas."
        />
        {canvas.isError || access.isError ? (
          <p role="alert">{(canvas.error ?? access.error)?.message}</p>
        ) : access.isPending ? (
          <p>Checking access…</p>
        ) : access.data?.role !== "manager" ? (
          <Card className="management-card">
            <h2>Manager access required</h2>
            <p>Only workspace managers can change canvas access and settings.</p>
          </Card>
        ) : (
          <>
            <EditableDetailsCard
              title="Canvas details"
              idPrefix="canvas-edit"
              name={canvas.data?.name ?? ""}
              description={canvas.data?.description ?? ""}
              onSave={async (input) => {
                await api.updateCanvas(canvasId, input);
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ["canvas", canvasId] }),
                  queryClient.invalidateQueries({ queryKey: ["canvases"] }),
                  queryClient.invalidateQueries({ queryKey: ["canvas-graph", canvasId] }),
                ]);
              }}
            />
            <Card className="management-card">
              <h2>Canvas access</h2>
              <p>Editors can change the diagram. Viewers can open and inspect it.</p>
              <form
                className="inline-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setMessage("");
                  try {
                    await api.addCanvasMember(canvasId, email, role);
                    setEmail("");
                    await refresh();
                  } catch (cause) {
                    setMessage(cause instanceof Error ? cause.message : "Could not add member");
                  }
                }}
              >
                <Input
                  type="email"
                  placeholder="Registered user's email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
                <select
                  aria-label="Canvas role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as typeof role)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <Button>
                  <Plus size={15} /> Add
                </Button>
              </form>
              <Members
                members={members.data ?? []}
                editable
                roles={["editor", "viewer"]}
                onUpdate={async (id, next) => {
                  await api.updateCanvasMember(canvasId, id, next as "editor" | "viewer");
                  await refresh();
                }}
                onRemove={async (id) => {
                  await api.removeCanvasMember(canvasId, id);
                  await refresh();
                }}
              />
            </Card>
            <Card className="management-card">
              <h2>Share a link</h2>
              <p>One person can use this link to join the canvas. It expires in 7 days.</p>
              <div className="inline-form">
                <select
                  aria-label="Invitation role"
                  value={linkRole}
                  onChange={(event) => setLinkRole(event.target.value as typeof linkRole)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <InviteLink create={() => api.inviteCanvas(canvasId, linkRole)} label="Create canvas link" />
              </div>
            </Card>
            <Card className="management-card danger-card">
              <h2>Delete canvas</h2>
              <p>This removes its diagram and sharing settings. Architecture entities may remain in the workspace.</p>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={15} /> Delete canvas
              </Button>
            </Card>
          </>
        )}
        {message && (
          <p role="status" className="management-message">
            {message}
          </p>
        )}
      </div>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <span className="dialog-mark dialog-mark-danger">
            <Trash2 size={19} />
          </span>
          <DialogTitle>Delete canvas?</DialogTitle>
          <DialogDescription>
            “{canvas.data?.name ?? "This canvas"}” and its sharing settings will be deleted. This cannot be undone.
          </DialogDescription>
          <div className="dialog-actions">
            <Button type="button" variant="ghost" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                setMessage("");
                try {
                  await api.deleteCanvas(canvasId);
                  await queryClient.invalidateQueries({ queryKey: ["canvases"] });
                  setDeleteOpen(false);
                  await navigate({ to: "/canvases" });
                } catch (cause) {
                  setMessage(cause instanceof Error ? cause.message : "Could not delete canvas");
                } finally {
                  setDeleting(false);
                }
              }}
            >
              <Trash2 size={15} /> {deleting ? "Deleting…" : "Delete canvas"}
            </Button>
          </div>
          {message && (
            <p role="alert" className="form-error">
              {message}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export function NewWorkspacePage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <AppShell>
      <div className="management-page">
        <Link to="/canvases" className="back-link">
          <ArrowLeft size={14} /> Canvases
        </Link>
        <PageIntro label="NEW WORKSPACE" title="Create a workspace" description="Keep your team's canvases together." />
        <Card className="management-card">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                const workspace = await api.createWorkspace({ name, description });
                await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
                await navigate({ to: "/canvases", search: { workspaceId: workspace.id } });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not create workspace");
                setBusy(false);
              }
            }}
          >
            <label htmlFor="workspace-new-name">
              Name
              <Input
                id="workspace-new-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                placeholder="e.g. Platform Team"
              />
            </label>
            <label htmlFor="workspace-new-description">
              Description
              <Textarea
                id="workspace-new-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
                placeholder="What is this workspace for?"
              />
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <Button disabled={busy}>
              <Plus size={15} /> Create workspace
            </Button>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
export function NoWorkspacePage() {
  return (
    <AppShell>
      <div className="management-page">
        <span className="eyebrow">WORKSPACES</span>
        <Card className="workspace-empty">
          <img src="/wooble-empty-canvas.png" alt="" className="empty-state-art" />
          <h1>No workspace access</h1>
          <p>Ask a workspace manager for an invitation link, or create a workspace for your team.</p>
          <Link to="/workspaces/new" className="action-link">
            <Plus size={15} /> Create workspace
          </Link>
        </Card>
      </div>
    </AppShell>
  );
}
