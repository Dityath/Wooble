import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Negative checks for scripts/selfhost-smoke.ts (#19): each phase must exit non-zero, naming the broken behavior,
// when the stack misbehaves. A fictional in-process API stands in for the stack, so no Docker is needed.

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts/selfhost-smoke.ts");
const temporaryRoots: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory() {
  const base = mkdtempSync(join(tmpdir(), "wooble-smoke-test-"));
  temporaryRoots.push(base);
  return base;
}

// The script runs asynchronously because the fake API lives in this process and must keep serving.
async function smoke(phase: string, options: { baseUrl?: string; state?: string; stdin?: string } = {}) {
  const child = Bun.spawn(["bun", script, phase], {
    cwd: root,
    env: {
      ...process.env,
      SMOKE_BASE_URL: options.baseUrl ?? "http://127.0.0.1:9",
      SMOKE_STATE: options.state ?? join(temporaryDirectory(), "state.json"),
      SMOKE_CADDY_CA: "",
    },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, output: stdout + stderr };
}

type Faults = {
  registration?: number;
  login?: number;
  crossOriginWrite?: number;
  closeLiveSocket?: boolean;
  loseDocumentation?: boolean;
  ignoreDocumentationWrites?: boolean;
};

const documentation = "Smoke test documentation that must survive restarts.";

/** A fictional API that behaves like a healthy stack unless a fault is set. */
function fakeApi(faults: Faults = {}) {
  let email = "";
  let storedDocumentation: string | undefined;
  const session = "wooble_session=fictional";
  const server = Bun.serve<undefined, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const body = request.body ? await request.json() : undefined;
      switch (route) {
        case "POST /api/auth/register":
          email = body.email;
          return Response.json(
            { email },
            { status: faults.registration ?? 201, headers: { "set-cookie": `${session}; HttpOnly` } },
          );
        case "POST /api/auth/login":
          return Response.json(
            { email: body.email },
            { status: faults.login ?? 200, headers: { "set-cookie": `${session}; HttpOnly` } },
          );
        case "GET /api/auth/me":
          return Response.json({ email });
        case "GET /api/workspaces":
          return Response.json([{ id: "workspace-1" }]);
        case "POST /api/canvases": {
          const foreign = request.headers.get("origin") !== url.origin;
          if (foreign) return Response.json({ message: "Forbidden" }, { status: faults.crossOriginWrite ?? 403 });
          return Response.json({ id: "canvas-1" }, { status: 201 });
        }
        case "POST /api/canvases/canvas-1/entities":
          return Response.json({ id: "entity-1" }, { status: 201 });
        case "PATCH /api/entities/entity-1":
          if (!faults.ignoreDocumentationWrites) storedDocumentation = body.metadata.documentation;
          return Response.json({ id: "entity-1" });
        case "GET /api/canvases/canvas-1/graph":
          return Response.json({
            entities: [
              {
                id: "entity-1",
                metadata: faults.loseDocumentation ? {} : { documentation: storedDocumentation ?? documentation },
              },
            ],
          });
        case "GET /api/canvases/canvas-1/live":
          return bunServer.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
        default:
          return Response.json({ message: "Not found" }, { status: 404 });
      }
    },
    websocket: {
      open(socket) {
        if (faults.closeLiveSocket) socket.close(4403, "Forbidden");
        else socket.send(JSON.stringify({ type: "presence", users: [] }));
      },
      message() {},
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function savedState() {
  const state = join(temporaryDirectory(), "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      email: "smoke-fictional@example.test",
      password: "Smoke-fictional",
      canvasId: "canvas-1",
      entityId: "entity-1",
    }),
  );
  return state;
}

const web = (url: string, port = 18083) => ({ Service: "web", Publishers: [{ URL: url, PublishedPort: port }] });
const internal = (service: string) => ({ Service: service, Publishers: [{ URL: "", PublishedPort: 0 }] });

describe("selfhost-smoke.ts ports", () => {
  it("passes when only web publishes a port, on loopback", async () => {
    const services = [web("127.0.0.1"), internal("api"), internal("postgres")];
    const asArray = await smoke("ports", { stdin: JSON.stringify(services) });
    expect(asArray.status).toBe(0);
    expect(asArray.output).toContain("Ports passed");
    const asLines = await smoke("ports", { stdin: services.map((service) => JSON.stringify(service)).join("\n") });
    expect(asLines.status).toBe(0);
  });

  it.each([
    ["api", { Service: "api", Publishers: [{ URL: "0.0.0.0", PublishedPort: 3000 }] }],
    ["postgres", { Service: "postgres", Publishers: [{ URL: "127.0.0.1", PublishedPort: 5432 }] }],
  ])("fails when %s publishes a host port", async (service, published) => {
    const result = await smoke("ports", { stdin: JSON.stringify([web("127.0.0.1"), published]) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`The ${service} service publishes a host port`);
  });

  it("fails when web listens beyond loopback", async () => {
    const result = await smoke("ports", { stdin: JSON.stringify([web("0.0.0.0"), internal("api")]) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("The web service listens on 0.0.0.0, expected 127.0.0.1");
  });

  it("fails when web publishes no port", async () => {
    const result = await smoke("ports", { stdin: JSON.stringify([internal("web"), internal("api")]) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("The web service publishes no port");
  });

  it("fails when web is not running", async () => {
    const result = await smoke("ports", { stdin: JSON.stringify([internal("api"), internal("postgres")]) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("The web service is not running");
  });
});

describe("selfhost-smoke.ts setup", () => {
  it("passes against a healthy stack", async () => {
    const result = await smoke("setup", { baseUrl: fakeApi() });
    expect(result.output).toContain("Setup passed");
    expect(result.status).toBe(0);
  });

  it("fails when registration fails", async () => {
    const result = await smoke("setup", { baseUrl: fakeApi({ registration: 500 }) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Registration returned 500");
  });

  it("fails when the live socket closes before presence", async () => {
    const result = await smoke("setup", { baseUrl: fakeApi({ closeLiveSocket: true }) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Live socket closed with 4403 before presence");
  });

  it("fails when a write from another origin is accepted", async () => {
    const result = await smoke("setup", { baseUrl: fakeApi({ crossOriginWrite: 201 }) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("A write from another origin returned 201, expected 403");
  });

  it("fails when the stack cannot be reached", async () => {
    const result = await smoke("setup");
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("Setup passed");
  });
});

describe("selfhost-smoke.ts verify", () => {
  it("passes when the saved content is still there", async () => {
    const result = await smoke("verify", { baseUrl: fakeApi(), state: savedState() });
    expect(result.output).toContain("Verify passed");
    expect(result.status).toBe(0);
  });

  it("fails when the account is gone, as after a lost volume", async () => {
    const result = await smoke("verify", { baseUrl: fakeApi({ login: 401 }), state: savedState() });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Login returned 401");
  });

  it("fails when the node documentation is lost", async () => {
    const result = await smoke("verify", { baseUrl: fakeApi({ loseDocumentation: true }), state: savedState() });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("The node or its documentation was lost");
  });

  it("fails when the live socket closes after sign-in", async () => {
    const result = await smoke("verify", { baseUrl: fakeApi({ closeLiveSocket: true }), state: savedState() });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Live socket closed with 4403 before presence");
  });
});

describe("selfhost-smoke.ts mutate", () => {
  it("passes when the smoke content changes", async () => {
    const result = await smoke("mutate", { baseUrl: fakeApi(), state: savedState() });
    expect(result.output).toContain("Mutation passed");
    expect(result.status).toBe(0);
  });

  // Without a real change, the restore rehearsal that follows would prove nothing.
  it("fails when the change is not kept", async () => {
    const result = await smoke("mutate", {
      baseUrl: fakeApi({ ignoreDocumentationWrites: true }),
      state: savedState(),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("The fictional smoke content did not change before restore");
  });
});
