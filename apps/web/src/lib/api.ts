import type {
  ArchitectureCanvas,
  ArchitectureConnection,
  ArchitectureEntity,
  CanvasNode,
  EntityMetadata,
  EntityType,
  ConnectionType,
  ConnectionBend,
  ConnectionPath,
} from "@wooble/domain";
import { canvasEventSchema, canvasGraphSchema, type CanvasEvent } from "@wooble/contracts";

const API_URL = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  role: "manager" | "member";
  canvasCount?: number;
}
export interface User {
  id: string;
  name: string;
  email: string;
  systemRole: "admin" | "user";
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}
export interface CanvasSummary extends ArchitectureCanvas {
  systemCount: number;
  serviceCount: number;
}
export interface CanvasGraph {
  canvas: ArchitectureCanvas;
  entities: ArchitectureEntity[];
  placements: CanvasNode[];
  connections: Array<ArchitectureConnection & { bend: ConnectionPath }>;
}
export interface ConnectionDetail extends ArchitectureConnection {
  sourceName: string;
  targetName: string;
}
export type { CanvasEvent };

export const api = {
  me: () => request<User>("/api/auth/me"),
  adminUsers: () => request<User[]>("/api/admin/users"),
  updateSystemRole: (id: string, systemRole: "admin" | "user") =>
    request<User>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ systemRole }) }),
  register: (input: { name: string; email: string; password: string; confirmPassword: string }) =>
    request<User>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<User>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  updateProfile: (name: string) =>
    request<User>("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ name }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  workspaces: () => request<WorkspaceSummary[]>("/api/workspaces"),
  workspace: (id: string) => request<WorkspaceSummary>(`/api/workspaces/${id}`),
  createWorkspace: (input: { name: string; description: string }) =>
    request<WorkspaceSummary>("/api/workspaces", { method: "POST", body: JSON.stringify(input) }),
  updateWorkspace: (id: string, input: { name: string; description: string }) =>
    request<WorkspaceSummary>(`/api/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  workspaceMembers: (id: string) => request<Member[]>(`/api/workspaces/${id}/members`),
  addWorkspaceMember: (id: string, email: string, role: "manager" | "member") =>
    request<Member>(`/api/workspaces/${id}/members`, { method: "POST", body: JSON.stringify({ email, role }) }),
  updateWorkspaceMember: (id: string, userId: string, role: "manager" | "member") =>
    request<Member>(`/api/workspaces/${id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (id: string, userId: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${id}/members/${userId}`, { method: "DELETE" }),
  inviteWorkspace: (id: string) => request<{ token: string }>(`/api/workspaces/${id}/invitations`, { method: "POST" }),
  invitation: (token: string) =>
    request<{ workspaceName: string; canvasName?: string; role: string; expiresAt: string }>(
      `/api/invitations/${token}`,
    ),
  acceptInvitation: (token: string) =>
    request<{ workspaceId: string; canvasId: string | null }>(`/api/invitations/${token}/accept`, { method: "POST" }),
  canvases: () => request<CanvasSummary[]>("/api/canvases"),
  canvas: (id: string) => request<ArchitectureCanvas>(`/api/canvases/${id}`),
  canvasAccess: (id: string) => request<{ role: "manager" | "editor" | "viewer" }>(`/api/canvases/${id}/access`),
  updateCanvas: (id: string, input: { name: string; description: string }) =>
    request<ArchitectureCanvas>(`/api/canvases/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  setCanvasShareMode: (id: string, shareMode: "restricted" | "link") =>
    request<ArchitectureCanvas>(`/api/canvases/${id}`, { method: "PATCH", body: JSON.stringify({ shareMode }) }),
  deleteCanvas: (id: string) => request<{ ok: boolean }>(`/api/canvases/${id}`, { method: "DELETE" }),
  canvasMembers: (id: string) => request<Member[]>(`/api/canvases/${id}/members`),
  addCanvasMember: (id: string, email: string, role: "editor" | "viewer") =>
    request<Member>(`/api/canvases/${id}/members`, { method: "POST", body: JSON.stringify({ email, role }) }),
  updateCanvasMember: (id: string, userId: string, role: "editor" | "viewer") =>
    request<Member>(`/api/canvases/${id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeCanvasMember: (id: string, userId: string) =>
    request<{ ok: boolean }>(`/api/canvases/${id}/members/${userId}`, { method: "DELETE" }),
  inviteCanvas: (id: string, role: "editor" | "viewer") =>
    request<{ token: string }>(`/api/canvases/${id}/invitations`, { method: "POST", body: JSON.stringify({ role }) }),
  graph: async (id: string) => {
    const response = await request<unknown>(`/api/canvases/${id}/graph`);
    return canvasGraphSchema.parse(response) as CanvasGraph;
  },
  canvasActivity: async (id: string, limit = 50) => {
    const response = await request<{ events: unknown[] }>(
      `/api/canvases/${id}/activity?limit=${encodeURIComponent(limit)}`,
    );
    return response.events.map((event) => canvasEventSchema.parse(event) as CanvasEvent);
  },
  entity: (id: string, canvasId?: string) =>
    request<ArchitectureEntity>(`/api/entities/${id}${canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : ""}`),
  connection: (id: string) => request<ConnectionDetail>(`/api/connections/${id}`),
  createCanvas: (input: { workspaceId: string; name: string; description: string }) =>
    request<CanvasSummary>("/api/canvases", { method: "POST", body: JSON.stringify(input) }),
  savePlacements: (canvasId: string, placements: CanvasNode[]) =>
    request<{ saved: number }>(`/api/canvases/${canvasId}/placements`, {
      method: "PUT",
      body: JSON.stringify({ placements }),
    }),
  createCanvasEntity: (
    canvasId: string,
    input: { type: EntityType; name: string; x: number; y: number; parentEntityId: string | null },
  ) => request<{ id: string }>(`/api/canvases/${canvasId}/entities`, { method: "POST", body: JSON.stringify(input) }),
  createCanvasConnection: (
    canvasId: string,
    input: { sourceEntityId: string; targetEntityId: string; type: ConnectionType },
  ) =>
    request<{ id: string }>(`/api/canvases/${canvasId}/connections`, { method: "POST", body: JSON.stringify(input) }),
  saveConnectionBend: (canvasId: string, connectionId: string, bend: ConnectionPath) =>
    request<{ bend: ConnectionPath }>(`/api/canvases/${canvasId}/connections/${connectionId}/bend`, {
      method: "PUT",
      body: JSON.stringify({ bend }),
    }),
  autoNeatCanvas: (
    canvasId: string,
    input: {
      expectedUpdatedAt: string;
      placements: Array<Omit<CanvasNode, "canvasId">>;
      connections: Array<{ connectionId: string; bend: ConnectionBend }>;
    },
  ) =>
    request<{ kind: "saved"; updatedAt: string }>(`/api/canvases/${canvasId}/auto-neat`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  updateEntity: (
    id: string,
    input: Partial<Pick<ArchitectureEntity, "type" | "name" | "description">> & {
      metadata?: Partial<Record<keyof EntityMetadata, string | string[] | Record<string, string> | null>>;
    },
  ) => request<ArchitectureEntity>(`/api/entities/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  updateConnection: (
    id: string,
    input: Partial<Pick<ArchitectureConnection, "type" | "label" | "description">> & {
      metadata?: {
        contract?: string | null;
        contractBody?: string | null;
        documentation?: string | null;
        direction?: "one-way" | "two-way" | null;
      };
    },
  ) => request<ArchitectureConnection>(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCanvasEntity: (canvasId: string, entityId: string) =>
    request<{ kind: "deleted"; removedNodes: number; removedConnections: number }>(
      `/api/canvases/${canvasId}/entities/${entityId}`,
      { method: "DELETE" },
    ),
  deleteCanvasConnection: (canvasId: string, connectionId: string) =>
    request<{ kind: "deleted" }>(`/api/canvases/${canvasId}/connections/${connectionId}`, { method: "DELETE" }),
  undoCanvas: (canvasId: string) =>
    request<{
      undone: boolean;
      action?: string;
      skipped?: Array<{ action: string; targetName: string | null; reason?: "conflict" | "no-op" }>;
    }>(`/api/canvases/${canvasId}/undo`, { method: "POST" }),
};

export function normalizeEntity(entity: ArchitectureEntity): ArchitectureEntity {
  return { ...entity, type: entity.type as EntityType, metadata: entity.metadata as EntityMetadata };
}
