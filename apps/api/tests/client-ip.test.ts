import { expect, test } from "bun:test";
import { clientIp } from "../src/lib/auth";

const server = { requestIP: () => ({ address: "10.0.0.2" }) };

test("client IP trusts forwarded addresses only when the proxy is explicitly trusted", () => {
  const previous = process.env.TRUST_PROXY;
  const request = new Request("http://localhost/api/auth/login", {
    headers: { "x-forwarded-for": "198.51.100.8, 10.0.0.2" },
  });
  try {
    process.env.TRUST_PROXY = "false";
    expect(clientIp({ server, request })).toBe("10.0.0.2");
    process.env.TRUST_PROXY = "true";
    expect(clientIp({ server, request })).toBe("198.51.100.8");
    const invalid = new Request("http://localhost/api/auth/login", {
      headers: { "x-forwarded-for": "invalid-ip" },
    });
    expect(clientIp({ server, request: invalid })).toBe("10.0.0.2");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});
