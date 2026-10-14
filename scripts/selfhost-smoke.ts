/**
 * Smoke test for a running self-hosted stack, used by .github/workflows/docker.yml.
 *
 *   bun scripts/selfhost-smoke.ts setup    register, create a canvas and node, edit it, check live presence and origins
 *   bun scripts/selfhost-smoke.ts verify   sign in again and check that the original content is still there
 *   bun scripts/selfhost-smoke.ts mutate   change only the fictional smoke canvas before restore rehearsal
 *   bun scripts/selfhost-smoke.ts ports    read `docker compose ps --format json` on stdin and check published ports
 *
 * SMOKE_BASE_URL is the supported web origin (default http://localhost:8080). SMOKE_STATE is a file that carries the
 * fictional account between phases; it is created with mode 600 and holds nothing else.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Not a Turborepo task, so these settings are read from the environment directly rather than declared in turbo.json.
const settings: Record<string, string | undefined> = process.env;
const base = settings.SMOKE_BASE_URL ?? "http://localhost:8080";
const statePath = settings.SMOKE_STATE ?? "selfhost-smoke-state.json";
const documentation = "Smoke test documentation that must survive restarts.";
const mutatedDocumentation = "Fictional smoke content changed before restore.";

const parsedBase = new URL(base);
if (settings.SMOKE_CADDY_CA) {
  const loopback =
    parsedBase.hostname === "localhost" || parsedBase.hostname === "127.0.0.1" || parsedBase.hostname === "[::1]";
  check(
    parsedBase.protocol === "https:" && loopback,
    "A Caddy smoke CA is allowed only for an HTTPS loopback smoke origin",
  );
  check(existsSync(settings.SMOKE_CADDY_CA), "SMOKE_CADDY_CA must point to the disposable Caddy certificate");
  check(
    settings.NODE_EXTRA_CA_CERTS === settings.SMOKE_CADDY_CA,
    "NODE_EXTRA_CA_CERTS must trust only the configured disposable Caddy certificate",
  );
}

type State = { email: string; password: string; canvasId: string; entityId: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function call(method: string, path: string, options: { cookie?: string; origin?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      origin: options.origin ?? base,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    body: text ? JSON.parse(text) : null,
  };
}

function presence(canvasId: string, cookie: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/canvases/${canvasId}/live`, {
      headers: { origin: base, cookie },
    } as unknown as string[]);
    // Settle before closing: Bun can dispatch the close event while close() runs.
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
      socket.close();
    };
    const timer = setTimeout(() => finish(new Error("No live presence message within 10 seconds")), 10_000);
    socket.addEventListener("message", (event) => {
      if ((JSON.parse(String(event.data)) as { type?: string }).type === "presence") finish();
    });
    socket.addEventListener("close", (event) =>
      finish(new Error(`Live socket closed with ${event.code} before presence`)),
    );
  });
}

async function setup() {
  const email = `smoke-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `Smoke-${crypto.randomUUID()}`;
  const registered = await call("POST", "/api/auth/register", {
    body: { name: "Smoke Test", email, password, confirmPassword: password },
  });
  check(registered.status === 201 && registered.cookie, `Registration returned ${registered.status}`);
  const cookie = registered.cookie;
  const me = await call("GET", "/api/auth/me", { cookie });
  check(me.status === 200 && me.body?.email === email, `GET /api/auth/me returned ${me.status}`);
  const [workspace] = (await call("GET", "/api/workspaces", { cookie })).body as Array<{ id: string }>;
  check(workspace, "Registration did not create a workspace");

  const canvas = await call("POST", "/api/canvases", {
    cookie,
    body: { workspaceId: workspace.id, name: "Smoke canvas", description: "" },
  });
  check(canvas.status === 201, `Creating a canvas returned ${canvas.status}`);
  const entity = await call("POST", `/api/canvases/${canvas.body.id}/entities`, {
    cookie,
    body: { type: "service", name: "Smoke Service", x: 0, y: 0, parentEntityId: null },
  });
  check(entity.status === 201, `Creating a node returned ${entity.status}`);
  const edited = await call("PATCH", `/api/entities/${entity.body.id}`, {
    cookie,
    body: { metadata: { documentation } },
  });
  check(edited.status === 200, `Editing the node returned ${edited.status}`);

  await presence(canvas.body.id, cookie);
  const otherSite = await call("POST", "/api/canvases", {
    cookie,
    origin: "https://attacker.example",
    body: { workspaceId: workspace.id, name: "Cross-site", description: "" },
  });
  check(otherSite.status === 403, `A write from another origin returned ${otherSite.status}, expected 403`);

  writeFileSync(statePath, JSON.stringify({ email, password, canvasId: canvas.body.id, entityId: entity.body.id }));
  chmodSync(statePath, 0o600);
  console.log("Setup passed: registration, canvas, node edit, live presence, and origin check");
}

async function verify() {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  const login = await call("POST", "/api/auth/login", { body: { email: state.email, password: state.password } });
  check(login.status === 200 && login.cookie, `Login returned ${login.status}`);
  const graph = await call("GET", `/api/canvases/${state.canvasId}/graph`, { cookie: login.cookie });
  check(graph.status === 200, `Reading the canvas returned ${graph.status}`);
  const entity = (graph.body.entities as Array<{ id: string; metadata: { documentation?: string } }>).find(
    (candidate) => candidate.id === state.entityId,
  );
  check(entity?.metadata.documentation === documentation, "The node or its documentation was lost");
  await presence(state.canvasId, login.cookie);
  console.log("Verify passed: sign-in, persisted canvas content, and live presence");
}

async function mutate() {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  const login = await call("POST", "/api/auth/login", { body: { email: state.email, password: state.password } });
  check(login.status === 200 && login.cookie, `Login before mutation returned ${login.status}`);
  const edited = await call("PATCH", `/api/entities/${state.entityId}`, {
    cookie: login.cookie,
    body: { metadata: { documentation: mutatedDocumentation } },
  });
  check(edited.status === 200, `Changing fictional smoke content returned ${edited.status}`);
  const graph = await call("GET", `/api/canvases/${state.canvasId}/graph`, { cookie: login.cookie });
  check(graph.status === 200, `Reading the changed canvas returned ${graph.status}`);
  const entity = (graph.body.entities as Array<{ id: string; metadata: { documentation?: string } }>).find(
    (candidate) => candidate.id === state.entityId,
  );
  check(
    entity?.metadata.documentation === mutatedDocumentation,
    "The fictional smoke content did not change before restore",
  );
  console.log("Mutation passed: disposable canvas content changed before restore rehearsal");
}

async function ports() {
  const input = await new Response(Bun.stdin.stream()).text();
  const services = input.trim().startsWith("[")
    ? (JSON.parse(input) as Array<Record<string, unknown>>)
    : input
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const service of services) {
    const published = ((service.Publishers as Array<{ URL: string; PublishedPort: number }> | null) ?? []).filter(
      (publisher) => publisher.PublishedPort > 0,
    );
    if (service.Service === "web") {
      check(published.length > 0, "The web service publishes no port");
      for (const publisher of published)
        check(publisher.URL === "127.0.0.1", `The web service listens on ${publisher.URL}, expected 127.0.0.1`);
    } else {
      check(published.length === 0, `The ${String(service.Service)} service publishes a host port`);
    }
  }
  check(
    services.some((service) => service.Service === "web"),
    "The web service is not running",
  );
  console.log("Ports passed: only the web service listens, on loopback");
}

const phases: Record<string, () => Promise<void>> = { setup, verify, mutate, ports };
const phase = phases[process.argv[2] ?? ""];
if (!phase) {
  console.error("Usage: bun scripts/selfhost-smoke.ts setup|verify|mutate|ports");
  process.exit(2);
}
await phase();
