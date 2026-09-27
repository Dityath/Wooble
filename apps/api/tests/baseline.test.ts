import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";

const app = createApp();

const email = `baseline-${crypto.randomUUID().slice(0, 8)}@example.test`;
const password = "WoobleTestPassword-2026";

type ApiResponse = Response & { json(): Promise<unknown> };

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
  path: string,
  headers: Record<string, string> = {},
  payload?: unknown,
): Promise<ApiResponse> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: payload === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }) as Request,
  ) as Promise<ApiResponse>;
}

beforeAll(() => {
  resetLoginAttempts();
});

afterAll(async () => {
  if (app.server) await app.stop(true);
});

describe("Baseline HTTP contract frozen before the Elysia migration", () => {
  it("reports health with database connectivity", async () => {
    const response = await request("GET", "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "connected" });
  });

  it("answers HEAD /health with 200 and an empty body", async () => {
    const response = await request("HEAD", "/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns the framework not-found shape outside /api", async () => {
    const response = await request("GET", "/definitely-not-a-route");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "Route GET:/definitely-not-a-route not found",
      error: "Not Found",
      statusCode: 404,
    });
  });

  it("guards unknown /api routes before routing", async () => {
    const response = await request("GET", "/api/definitely-not-a-route");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Sign in to continue" });
  });

  it("registers a user with the exact session cookie attributes", async () => {
    const response = await request(
      "POST",
      "/api/auth/register",
      {},
      {
        name: "Baseline",
        email,
        password,
        confirmPassword: password,
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "Baseline", email, systemRole: "user" });
    const cookie = response.headers.get("set-cookie");
    expect(cookie?.startsWith("wooble_session=")).toBe(true);
    expect(cookie?.endsWith("; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600")).toBe(true);
    expect(cookie?.includes("Secure")).toBe(false);
  });

  it("keeps the framework not-found shape for unknown /api routes with a session", async () => {
    const registered = await request("POST", "/api/auth/login", {}, { email, password });
    expect(registered.status).toBe(200);
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    const response = await request("GET", "/api/definitely-not-a-route", { cookie: cookie ?? "" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "Route GET:/api/definitely-not-a-route not found",
      error: "Not Found",
      statusCode: 404,
    });
  });

  it("rejects duplicate registration emails with 409", async () => {
    const response = await request(
      "POST",
      "/api/auth/register",
      {},
      {
        name: "Baseline Two",
        email,
        password,
        confirmPassword: password,
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Email is already registered" });
  });

  it("rejects a malformed JSON body with the framework parse message", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
  });

  it("treats a text body on a JSON route as a validation failure", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request", message: "Invalid email or password" });
  });

  it("answers preflight before the access guard on known and unknown routes", async () => {
    const known = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
      }),
    );
    expect(known.status).toBe(204);
    expect(known.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(known.headers.get("access-control-allow-credentials")).toBe("true");
    expect(known.headers.get("access-control-allow-methods")).toBe("GET,HEAD,PUT,PATCH,POST,DELETE");
    const unknown = await app.handle(
      new Request("http://localhost/api/definitely-not-a-route", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
      }),
    );
    expect(unknown.status).toBe(204);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(unknown.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("runs the access guard before body validation", async () => {
    const response = await request("POST", "/api/auth/profile", {}, { name: "" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Sign in to continue" });
  });

  it("clears the session cookie on logout", async () => {
    const login = await request("POST", "/api/auth/login", {}, { email, password });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await request("POST", "/api/auth/logout", { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBe("wooble_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  });
});
