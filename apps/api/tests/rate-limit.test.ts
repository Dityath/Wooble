import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";

const app = createApp();
const previousTrustProxy = process.env.TRUST_PROXY;
const previousTrustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS;

beforeAll(() => {
  resetLoginAttempts();
  process.env.TRUST_PROXY = "true";
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
});

afterAll(async () => {
  if (app.server) await app.stop(true);
  if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previousTrustProxy;
  if (previousTrustedProxyCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = previousTrustedProxyCidrs;
});

test("spoofed X-Forwarded-For headers cannot bypass login limits from an untrusted direct peer", async () => {
  const login = (email: string, spoofedIp: string) =>
    app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": spoofedIp },
        body: JSON.stringify({ email, password: "WhateverPassword-2026" }),
      }),
    );
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await login(
      `rate-${attempt}-${crypto.randomUUID().slice(0, 6)}@example.test`,
      `198.51.100.${attempt}`,
    );
    // Failed DB lookups (503) are expected when the integration test is run without PostgreSQL.
    expect([401, 503]).toContain(response.status);
  }
  const eleventh = await login("rate-eleventh@example.test", "203.0.113.90");
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
