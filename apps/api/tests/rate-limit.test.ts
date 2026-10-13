import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { resetLoginAttempts } from "../src/modules/auth/routes";

const app = createApp();
const previousTrustProxy = process.env.TRUST_PROXY;
const previousTrustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS;
const login = (xff?: string) =>
  app.handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(xff === undefined ? {} : { "x-forwarded-for": xff }),
      },
      body: JSON.stringify({ email: `rate-${crypto.randomUUID()}@example.test`, password: "WhateverPassword-2026" }),
    }),
  );

async function exhaustBucket(xff: string | undefined) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await login(xff);
    // Failed DB lookups (503) are expected when the integration test runs without PostgreSQL.
    expect([401, 503]).toContain(response.status);
  }
}

beforeAll(() => {
  process.env.TRUST_PROXY = "true";
  process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32";
});

beforeEach(() => resetLoginAttempts());

afterAll(async () => {
  if (app.server) await app.stop(true);
  if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previousTrustProxy;
  if (previousTrustedProxyCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = previousTrustedProxyCidrs;
});

test("trusted proxy login limits use the rightmost client and ignore a spoofed leftmost address", async () => {
  await exhaustBucket("203.0.113.90, 198.51.100.10");
  expect((await login("192.0.2.44, 198.51.100.10")).status).toBe(429);
  expect([401, 503]).toContain((await login("203.0.113.90, 198.51.100.11")).status);
});

test("trusted proxy login limits stop at an untrusted forwarded hop", async () => {
  await exhaustBucket("198.51.100.10, 192.0.2.20");
  expect((await login("203.0.113.99, 192.0.2.20")).status).toBe(429);
  expect([401, 503]).toContain((await login("198.51.100.10, 192.0.2.21")).status);
});

test("direct login access ignores X-Forwarded-For and shares the direct peer bucket", async () => {
  process.env.TRUST_PROXY = "false";
  await exhaustBucket("198.51.100.10");
  expect((await login("203.0.113.99")).status).toBe(429);
  process.env.TRUST_PROXY = "true";
});

test("an untrusted direct hop cannot use spoofed X-Forwarded-For to evade login limits", async () => {
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
  await exhaustBucket("198.51.100.10");
  expect((await login("203.0.113.90")).status).toBe(429);
});
