import { afterEach, expect, test } from "bun:test";
import { clientIp } from "../src/lib/auth";

const originalTrustProxy = process.env.TRUST_PROXY;
const originalTrustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS;
const requestFor = (xff?: string) =>
  new Request("http://localhost/api/auth/login", {
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });
const peer = (address: string) => ({ requestIP: () => ({ address }) });

afterEach(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
  if (originalTrustedProxyCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = originalTrustedProxyCidrs;
});

test("ignores spoofed forwarding headers from an untrusted peer", () => {
  process.env.TRUST_PROXY = "true";
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
  expect(clientIp({ server: peer("198.51.100.9"), request: requestFor("203.0.113.8") })).toBe("198.51.100.9");
});

test("resolves the client behind the explicitly trusted Caddy peer", () => {
  process.env.TRUST_PROXY = "true";
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
  expect(clientIp({ server: peer("172.30.0.2"), request: requestFor("198.51.100.8") })).toBe("198.51.100.8");
});

test("walks a trusted chain from right to left and stops at the first untrusted hop", () => {
  process.env.TRUST_PROXY = "true";
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32,10.0.0.0/8";
  expect(clientIp({ server: peer("172.30.0.2"), request: requestFor("198.51.100.8, 10.0.0.3") })).toBe("198.51.100.8");
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
  expect(clientIp({ server: peer("172.30.0.2"), request: requestFor("198.51.100.8, 192.0.2.4") })).toBe("192.0.2.4");
});

test("uses direct peer identity and fails safe for malformed or empty chains", () => {
  process.env.TRUST_PROXY = "false";
  process.env.TRUSTED_PROXY_CIDRS = "172.30.0.2/32";
  expect(clientIp({ server: peer("198.51.100.9"), request: requestFor("203.0.113.8") })).toBe("198.51.100.9");
  process.env.TRUST_PROXY = "true";
  expect(clientIp({ server: peer("172.30.0.2"), request: requestFor("203.0.113.8, ") })).toBe("172.30.0.2");
  expect(clientIp({ server: peer("172.30.0.2"), request: requestFor("not-an-ip") })).toBe("172.30.0.2");
});
