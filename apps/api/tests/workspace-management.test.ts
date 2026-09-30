import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db, invitations } from "@wooble/db";
import { hashToken } from "../src/lib/auth";
import { resetLoginAttempts } from "../src/modules/auth/routes";
import { apiClient } from "./support/client";

const api = apiClient();
beforeEach(() => resetLoginAttempts());

type Workspace = { id: string; name: string; description: string; role: string; canvasCount?: number };
type Member = { id: string; name: string; email: string; role: string };

async function join(session: string, token: string) {
  return api.json<{ workspaceId: string; canvasId: string | null }>(
    "POST",
    `/api/invitations/${token}/accept`,
    session,
  );
}

describe("workspace details", () => {
  it("returns the workspace with its canvas count and the caller's role", async () => {
    const owner = await api.register("Workspace Owner");
    await api.createCanvas(owner.session, owner.workspaceId, "First");
    await api.createCanvas(owner.session, owner.workspaceId, "Second");
    const { status, body } = await api.json<Workspace>("GET", `/api/workspaces/${owner.workspaceId}`, owner.session);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: owner.workspaceId, name: "My Workspace", canvasCount: 2, role: "manager" });
    expect((await api.request("GET", "/api/workspaces/not-a-uuid", owner.session)).status).toBe(400);
  });

  it("lets managers rename a workspace and blocks members", async () => {
    const owner = await api.register("Renaming Owner");
    const member = await api.register("Renaming Member");
    await join(member.session, await api.invite(owner.session, `/api/workspaces/${owner.workspaceId}/invitations`));
    const url = `/api/workspaces/${owner.workspaceId}`;

    const renamed = await api.json<Workspace>("PATCH", url, owner.session, { name: " Platform ", description: "Core" });
    expect(renamed.body).toMatchObject({ name: "Platform", description: "Core", role: "manager" });
    expect((await api.json<Workspace>("GET", url, member.session)).body.role).toBe("member");
    expect((await api.request("PATCH", url, member.session, { name: "Hijacked" })).status).toBe(403);
    expect((await api.request("PATCH", url, owner.session, {})).status).toBe(400);
    expect((await api.request("PATCH", url, owner.session, { name: "" })).status).toBe(400);
    expect((await api.request("PATCH", "/api/workspaces/not-a-uuid", owner.session, { name: "x" })).status).toBe(400);
  });

  it("hides workspaces from people outside them, except system admins", async () => {
    const owner = await api.register("Private Owner");
    const outsider = await api.register("Workspace Outsider");
    const admin = await api.register("Workspace Admin");
    await api.promoteToAdmin(admin.user.id);
    const url = `/api/workspaces/${owner.workspaceId}`;
    expect((await api.request("GET", url, outsider.session)).status).toBe(403);
    expect((await api.json<Workspace>("GET", url, admin.session)).body.role).toBe("manager");
    const adminList = await api.json<Workspace[]>("GET", "/api/workspaces", admin.session);
    expect(adminList.body.find((row) => row.id === owner.workspaceId)?.role).toBe("manager");
    expect((await api.request("GET", `/api/workspaces/${crypto.randomUUID()}`, admin.session)).status).toBe(404);
    expect(
      (await api.request("PATCH", `/api/workspaces/${crypto.randomUUID()}`, admin.session, { name: "Ghost" })).status,
    ).toBe(404);
  });

  it("creates additional workspaces for their creator", async () => {
    const owner = await api.register("Workspace Creator");
    const created = await api.json<Workspace>("POST", "/api/workspaces", owner.session, { name: "Research" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Research", description: "", role: "manager" });
    expect((await api.request("POST", "/api/workspaces", owner.session, { name: "" })).status).toBe(400);
  });
});

describe("workspace members", () => {
  it("adds, re-roles, lists, and removes members", async () => {
    const owner = await api.register("Member Owner");
    const colleague = await api.register("Member Colleague");
    const base = `/api/workspaces/${owner.workspaceId}/members`;

    const added = await api.json<{ id: string; role: string }>("POST", base, owner.session, {
      email: ` ${colleague.user.email.toUpperCase()} `,
      role: "member",
    });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ id: colleague.user.id, role: "member" });
    expect((await api.json<Workspace>("GET", `/api/workspaces/${owner.workspaceId}`, colleague.session)).status).toBe(
      200,
    );

    const promoted = await api.json<{ role: string }>("PATCH", `${base}/${colleague.user.id}`, owner.session, {
      role: "manager",
    });
    expect(promoted.body.role).toBe("manager");
    const list = await api.json<Member[]>("GET", base, colleague.session);
    expect(list.body.map((row) => [row.id, row.role])).toEqual(
      expect.arrayContaining([
        [owner.user.id, "manager"],
        [colleague.user.id, "manager"],
      ]),
    );

    const readded = await api.json<{ role: string }>("POST", base, owner.session, {
      email: colleague.user.email,
      role: "member",
    });
    expect(readded.body.role).toBe("member");

    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    const token = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor");
    await join(colleague.session, token);
    expect((await api.request("GET", `/api/canvases/${canvasId}/graph`, colleague.session)).status).toBe(200);

    expect((await api.request("DELETE", `${base}/${colleague.user.id}`, owner.session)).status).toBe(200);
    expect((await api.request("GET", `/api/workspaces/${owner.workspaceId}`, colleague.session)).status).toBe(403);
    expect((await api.request("GET", `/api/canvases/${canvasId}/graph`, colleague.session)).status).toBe(403);
  });

  it("rejects unknown people, invalid input, and removing yourself", async () => {
    const owner = await api.register("Strict Owner");
    const base = `/api/workspaces/${owner.workspaceId}/members`;
    const unknown = await api.json<{ message: string }>("POST", base, owner.session, {
      email: "nobody@example.test",
      role: "member",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe("User must register before they can be added");
    expect((await api.request("POST", base, owner.session, { email: "not-an-email", role: "member" })).status).toBe(
      400,
    );
    expect(
      (await api.request("POST", "/api/workspaces/not-a-uuid/members", owner.session, { email: "a@example.test" }))
        .status,
    ).toBe(400);
    expect((await api.request("GET", "/api/workspaces/not-a-uuid/members", owner.session)).status).toBe(400);
    expect(
      (await api.request("PATCH", `${base}/${crypto.randomUUID()}`, owner.session, { role: "manager" })).status,
    ).toBe(404);
    expect((await api.request("PATCH", `${base}/${owner.user.id}`, owner.session, { role: "owner" })).status).toBe(400);
    const self = await api.json<{ message: string }>("DELETE", `${base}/${owner.user.id}`, owner.session);
    expect(self.status).toBe(400);
    expect(self.body.message).toBe("You cannot remove yourself from a workspace you manage");
    expect((await api.request("DELETE", `${base}/not-a-uuid`, owner.session)).status).toBe(400);
  });

  it("lets members read the member list but not change it", async () => {
    const owner = await api.register("Guarded Owner");
    const member = await api.register("Guarded Member");
    await join(member.session, await api.invite(owner.session, `/api/workspaces/${owner.workspaceId}/invitations`));
    const base = `/api/workspaces/${owner.workspaceId}/members`;
    expect((await api.request("GET", base, member.session)).status).toBe(200);
    expect((await api.request("POST", base, member.session, { email: owner.user.email, role: "member" })).status).toBe(
      403,
    );
    expect((await api.request("DELETE", `${base}/${owner.user.id}`, member.session)).status).toBe(403);
    expect((await api.request("POST", `/api/workspaces/${owner.workspaceId}/invitations`, member.session)).status).toBe(
      403,
    );
  });
});

describe("invitations", () => {
  it("describes a workspace invitation and joins as a member", async () => {
    const owner = await api.register("Inviting Owner");
    const guest = await api.register("Invited Guest");
    const token = await api.invite(owner.session, `/api/workspaces/${owner.workspaceId}/invitations`);

    const details = await api.json<{ workspaceName: string; canvasName?: string; role: string; expiresAt: string }>(
      "GET",
      `/api/invitations/${token}`,
      guest.session,
    );
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({ workspaceName: "My Workspace", role: "member" });
    expect(details.body.canvasName).toBeUndefined();
    expect(Date.parse(details.body.expiresAt)).toBeGreaterThan(Date.now());

    const accepted = await join(guest.session, token);
    expect(accepted.body).toEqual({ workspaceId: owner.workspaceId, canvasId: null });
    const workspace = await api.json<Workspace>("GET", `/api/workspaces/${owner.workspaceId}`, guest.session);
    expect(workspace.body.role).toBe("member");
    expect((await api.request("GET", `/api/invitations/${token}`, guest.session)).status).toBe(404);
  });

  it("describes a canvas invitation and never downgrades an editor", async () => {
    const owner = await api.register("Canvas Inviter");
    const guest = await api.register("Canvas Guest");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId, "Fulfilment");
    const editorToken = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "editor");
    const details = await api.json<{ canvasName: string; role: string }>(
      "GET",
      `/api/invitations/${editorToken}`,
      guest.session,
    );
    expect(details.body).toMatchObject({ canvasName: "Fulfilment", role: "editor" });
    expect((await join(guest.session, editorToken)).body).toEqual({ workspaceId: owner.workspaceId, canvasId });

    const viewerToken = await api.invite(owner.session, `/api/canvases/${canvasId}/invitations`, "viewer");
    await join(guest.session, viewerToken);
    const access = await api.json<{ role: string }>("GET", `/api/canvases/${canvasId}/access`, guest.session);
    expect(access.body.role).toBe("editor");
  });

  it("refuses expired, malformed, and unknown invitations", async () => {
    const owner = await api.register("Expiring Owner");
    const guest = await api.register("Late Guest");
    const token = await api.invite(owner.session, `/api/workspaces/${owner.workspaceId}/invitations`);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.tokenHash, hashToken(token)));

    expect((await api.request("GET", `/api/invitations/${token}`, guest.session)).status).toBe(404);
    const late = await api.json<{ message: string }>("POST", `/api/invitations/${token}/accept`, guest.session);
    expect(late.status).toBe(404);
    expect(late.body.message).toBe("Invitation is unavailable or expired");
    expect((await api.request("GET", "/api/invitations/short", guest.session)).status).toBe(400);
    expect((await api.request("POST", "/api/invitations/short/accept", guest.session)).status).toBe(400);
    expect((await api.request("GET", `/api/invitations/${"x".repeat(40)}`, guest.session)).status).toBe(404);
    expect((await api.request("GET", `/api/workspaces/${owner.workspaceId}`, guest.session)).status).toBe(403);
  });

  it("rejects canvas invitations with an invalid role or a missing canvas", async () => {
    const owner = await api.register("Canvas Invite Checker");
    const canvasId = await api.createCanvas(owner.session, owner.workspaceId);
    expect(
      (await api.request("POST", `/api/canvases/${canvasId}/invitations`, owner.session, { role: "owner" })).status,
    ).toBe(400);
    const admin = await api.register("Invite Admin");
    await api.promoteToAdmin(admin.user.id);
    expect(
      (await api.request("POST", `/api/canvases/${crypto.randomUUID()}/invitations`, admin.session, { role: "viewer" }))
        .status,
    ).toBe(403);
  });
});
