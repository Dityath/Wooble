import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";

const app = createApp({
  configure: (configured) => {
    configured.get("/test-database-error", async () => {
      throw Object.assign(new Error("Failed query: select token_hash from sessions"), {
        cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      });
    });
    configured.get("/test-unauthorized", async () => {
      throw Object.assign(new Error("Sign in to continue"), { status: 401 });
    });
  },
});

beforeAll(() => {
  resetLoginAttempts();
});

afterAll(async () => {
  if (app.server) await app.stop(true);
});

describe("API error responses", () => {
  it("accepts a Vite fallback port for state-changing requests", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { origin: "http://localhost:5174", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
  });

  it("rejects state-changing requests from another origin", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { origin: "https://another.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("keeps database query details out of the response", async () => {
    const response = await app.handle(new Request("http://localhost/test-database-error"));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ message: "The service is temporarily unavailable. Try again in a moment." });
    expect(body).not.toContain("token_hash");
  });

  it("preserves expected authorization errors", async () => {
    const response = await app.handle(new Request("http://localhost/test-unauthorized"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Sign in to continue" });
  });
});
