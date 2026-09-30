import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db, users } from "@wooble/db";
import { createApp } from "../../src/app";

export const password = "WoobleTestPassword-2026";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** An in-process API client with fictional, uniquely named accounts for one test file. */
export function apiClient() {
  const app = createApp();
  const unique = crypto.randomUUID().slice(0, 8);
  let accounts = 0;

  async function request(method: Method, url: string, session?: string, payload?: unknown) {
    const response = await app.handle(
      new Request(`http://localhost${url}`, {
        method,
        headers: {
          ...(session ? { cookie: session } : {}),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
    );
    return response;
  }

  async function json<T>(method: Method, url: string, session?: string, payload?: unknown) {
    const response = await request(method, url, session, payload);
    return { status: response.status, body: (await response.json()) as T, response };
  }

  async function register(name: string) {
    const email = `${name.toLowerCase().replace(/\s+/g, "-")}-${unique}-${++accounts}@example.test`;
    const response = await request("POST", "/api/auth/register", undefined, {
      name,
      email,
      password,
      confirmPassword: password,
    });
    expect(response.status).toBe(201);
    const user = (await response.json()) as { id: string; email: string; name: string };
    const session = response.headers.get("set-cookie")?.split(";")[0] as string;
    const [workspace] = (await (await request("GET", "/api/workspaces", session)).json()) as Array<{ id: string }>;
    return { user, session, workspaceId: workspace.id };
  }

  async function promoteToAdmin(userId: string) {
    await db.update(users).set({ systemRole: "admin" }).where(eq(users.id, userId));
  }

  async function createCanvas(session: string, workspaceId: string, name = "Checkout flow") {
    const { status, body } = await json<{ id: string }>("POST", "/api/canvases", session, {
      workspaceId,
      name,
      description: "",
    });
    expect(status).toBe(201);
    return body.id;
  }

  async function createNode(
    session: string,
    canvasId: string,
    input: { type?: string; name?: string; x?: number; y?: number; parentEntityId?: string | null } = {},
  ) {
    const { status, body } = await json<{ id: string }>("POST", `/api/canvases/${canvasId}/entities`, session, {
      type: "service",
      name: "",
      x: 0,
      y: 0,
      parentEntityId: null,
      ...input,
    });
    expect(status).toBe(201);
    return body.id;
  }

  async function connect(session: string, canvasId: string, sourceEntityId: string, targetEntityId: string) {
    const { status, body } = await json<{ id: string }>("POST", `/api/canvases/${canvasId}/connections`, session, {
      sourceEntityId,
      targetEntityId,
      type: "rest",
    });
    expect(status).toBe(201);
    return body.id;
  }

  async function invite(session: string, url: string, role?: "editor" | "viewer") {
    const { status, body } = await json<{ token: string }>("POST", url, session, role ? { role } : undefined);
    expect(status).toBe(201);
    return body.token;
  }

  return { app, unique, request, json, register, promoteToAdmin, createCanvas, createNode, connect, invite };
}
