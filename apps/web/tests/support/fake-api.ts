/**
 * An in-memory stand-in for the Wooble API, installed as `fetch`. Tests register the routes a journey
 * needs, then assert on rendered UI and on the requests the app sent.
 */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
}

type Result = unknown | FakeReply | Promise<unknown | FakeReply>;
type Handler = (request: FakeRequest) => Result;

class FakeReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** Reply with an explicit status. Error replies use the API's `{ message }` shape. */
export function reply(status: number, body: unknown = status >= 400 ? { message: `Error ${status}` } : {}) {
  return new FakeReply(status, body);
}

export function failWith(status: number, message: string) {
  return new FakeReply(status, { message });
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class FakeApi {
  readonly calls: FakeRequest[] = [];
  readonly unhandled: string[] = [];
  private routes: Route[] = [];
  private originalFetch = globalThis.fetch;

  /** Register a route such as `PATCH /api/entities/:entityId`. Later registrations win. */
  on(route: string, handler: Handler): this;
  on(route: string, response: unknown): this;
  on(route: string, handler: unknown) {
    const [method, path] = route.split(" ");
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.routes.unshift({
      method,
      pattern,
      keys,
      handler: typeof handler === "function" ? (handler as Handler) : () => handler,
    });
    return this;
  }

  /** Requests sent to a route, optionally filtered by method. */
  requests(method: string, path: string | RegExp) {
    return this.calls.filter(
      (call) => call.method === method && (typeof path === "string" ? call.path === path : path.test(call.path)),
    );
  }

  install() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.href,
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
        const request = { method, path: url.pathname, query: url.searchParams, params, body };
        this.calls.push(request);
        const result = await route.handler(request);
        const { status, payload } =
          result instanceof FakeReply
            ? { status: result.status, payload: result.body }
            : { status: 200, payload: result };
        return new Response(JSON.stringify(payload ?? null), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      this.unhandled.push(`${method} ${url.pathname}`);
      return new Response(JSON.stringify({ message: `Unhandled ${method} ${url.pathname}` }), { status: 501 });
    }) as typeof fetch;
    return this;
  }

  restore() {
    globalThis.fetch = this.originalFetch;
  }
}
