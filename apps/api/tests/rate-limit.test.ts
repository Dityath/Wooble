import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { authAttemptLimit, resetLoginAttempts } from "../src/modules/auth/routes";

const app = createApp();

beforeAll(() => {
  resetLoginAttempts();
});

afterAll(async () => {
  if (app.server) await app.stop(true);
});

test("limits login attempts per IP to just over 10 within a 15 minute window", async () => {
  const login = (email: string) =>
    app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "WhateverPassword-2026" }),
      }),
    );
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await login(`rate-${attempt}-${crypto.randomUUID().slice(0, 6)}@example.test`);
    expect(response.status).toBe(401);
  }
  const eleventh = await login("rate-eleventh@example.test");
  expect(eleventh.status).toBe(429);
  expect(await eleventh.json()).toEqual({ message: "Too many attempts. Try again later" });
  const blocked = await app.handle(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rate",
        email: "rate-blocked@example.test",
        password: "WhateverPassword-2026",
        confirmPassword: "WhateverPassword-2026",
      }),
    }),
  );
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ message: "Too many attempts. Try again later" });
});

test("raises the limit only for test runs through AUTH_ATTEMPT_LIMIT", () => {
  expect(authAttemptLimit({})).toBe(10);
  expect(authAttemptLimit({ AUTH_ATTEMPT_LIMIT: "" })).toBe(10);
  expect(authAttemptLimit({ AUTH_ATTEMPT_LIMIT: "500", NODE_ENV: "test" })).toBe(500);
  expect(() => authAttemptLimit({ AUTH_ATTEMPT_LIMIT: "500", NODE_ENV: "production" })).toThrow(
    "AUTH_ATTEMPT_LIMIT is for test runs and cannot be used in production",
  );
  expect(authAttemptLimit({ NODE_ENV: "production" })).toBe(10);
  for (const invalid of ["0", "-3", "2.5", "many"])
    expect(() => authAttemptLimit({ AUTH_ATTEMPT_LIMIT: invalid })).toThrow("positive whole number");
});
