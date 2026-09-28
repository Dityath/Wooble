import type { APIRequestContext, BrowserContext } from "@playwright/test";

export const SESSION_COOKIE = "wooble_session";
export const TEST_PASSWORD = "WoobleBrowserPassword-2026";
export const MOD = process.platform === "darwin" ? "Meta" : "Control";
export const MOD_SYMBOL = process.platform === "darwin" ? "⌘" : "Ctrl+";

export interface TestUser {
  email: string;
  cookieValue: string;
}

export interface SeededCanvas {
  canvasId: string;
  systemId: string;
  alphaId: string;
  betaId: string;
  connectionId: string;
}

function authHeaders(cookieValue: string) {
  return { cookie: `${SESSION_COOKIE}=${cookieValue}` };
}

export async function registerUser(request: APIRequestContext, name: string): Promise<TestUser> {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const response = await request.post("/api/auth/register", {
    data: { name: `Browser ${name}`, email, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
  });
  if (response.status() !== 201) {
    throw new Error(`register failed (${response.status()}): ${await response.text()}`);
  }
  const setCookie = response
    .headersArray()
    .find((header) => header.name.toLowerCase() === "set-cookie")
    ?.value.split(";")[0];
  const cookieValue = setCookie?.slice(SESSION_COOKIE.length + 1) ?? "";
  if (!cookieValue) throw new Error("register did not return a session cookie");
  return { email, cookieValue };
}

export async function signIn(context: BrowserContext, cookieValue: string) {
  await context.addCookies([{ name: SESSION_COOKIE, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
}

export async function seedCanvas(request: APIRequestContext, cookieValue: string): Promise<SeededCanvas> {
  const headers = authHeaders(cookieValue);
  const workspace = await request.post("/api/workspaces", {
    headers,
    data: { name: "Browser workspace", description: "" },
  });
  if (workspace.status() !== 201) throw new Error(`workspace failed: ${await workspace.text()}`);
  const { id: workspaceId } = (await workspace.json()) as { id: string };
  const canvas = await request.post("/api/canvases", {
    headers,
    data: { workspaceId, name: "Browser canvas", description: "" },
  });
  if (canvas.status() !== 201) throw new Error(`canvas failed: ${await canvas.text()}`);
  const { id: canvasId } = (await canvas.json()) as { id: string };
  const createNode = async (type: string, name: string, x: number, y: number) => {
    const response = await request.post(`/api/canvases/${canvasId}/entities`, {
      headers,
      data: { type, name, x, y, parentEntityId: null },
    });
    if (response.status() !== 201) throw new Error(`node ${name} failed: ${await response.text()}`);
    return ((await response.json()) as { id: string }).id;
  };
  const systemId = await createNode("system", "Browser System", 0, 0);
  const alphaId = await createNode("service", "Alpha Service", 700, 40);
  const betaId = await createNode("service", "Beta Service", 700, 340);
  const connection = await request.post(`/api/canvases/${canvasId}/connections`, {
    headers,
    data: { sourceEntityId: alphaId, targetEntityId: betaId, type: "rest" },
  });
  if (connection.status() !== 201) throw new Error(`connection failed: ${await connection.text()}`);
  const { id: connectionId } = (await connection.json()) as { id: string };
  return { canvasId, systemId, alphaId, betaId, connectionId };
}

export async function addCanvasMember(
  request: APIRequestContext,
  cookieValue: string,
  canvasId: string,
  email: string,
  role: "editor" | "viewer",
) {
  const response = await request.post(`/api/canvases/${canvasId}/members`, {
    headers: authHeaders(cookieValue),
    data: { email, role },
  });
  if (response.status() !== 201) throw new Error(`member add failed: ${await response.text()}`);
}
