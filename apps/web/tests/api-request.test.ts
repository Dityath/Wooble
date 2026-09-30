import { expect, test } from "bun:test";
import { api } from "../src/lib/api";

test("DELETE requests omit JSON content type when there is no body", async () => {
  const originalFetch = globalThis.fetch;
  let actual: RequestInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    actual = init;
    return new Response(JSON.stringify({ kind: "deleted" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await api.deleteCanvasEntity("canvas", "entity");
    expect(actual?.method).toBe("DELETE");
    expect(actual?.body).toBeUndefined();
    expect(actual?.headers).toEqual({});
  } finally {
    globalThis.fetch = originalFetch;
  }
});
