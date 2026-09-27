# Self-host Wooble

Wooble needs a web server, its Bun API, and PostgreSQL. The Docker path below starts all three on one machine. The Bun path is for operators who prefer to run the application processes themselves. These instructions target a private machine, LAN, or VPN while email verification and account recovery are not implemented.

## Docker: quickest local installation

Prerequisites: Docker Engine with Compose, and free port 8080. From the repository root:

```sh
cp .env.selfhost.example .env.selfhost
```

Edit `.env.selfhost` and replace `WOOBLE_DB_PASSWORD` with a long random alphanumeric password. Keep `WOOBLE_ORIGIN=http://localhost:8080` for access from the same machine. Then start the stack:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml up --build -d
docker compose --env-file .env.selfhost -f compose.selfhost.yml ps
```

Open <http://localhost:8080> and register your first account. Registration creates **My Workspace**. The first account is a regular user; if a system administrator is needed, promote that account explicitly:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec api \
  bun apps/api/scripts/promote-admin.ts you@example.com
```

The stack waits for PostgreSQL to become healthy, applies checked-in migrations, and then starts the API and web server. The browser uses the same origin for the web UI, API, and WebSocket connection. PostgreSQL and the API have no host-published ports. The web server binds to `127.0.0.1` only. Set `WOOBLE_HTTP_PORT` and the matching port in `WOOBLE_ORIGIN` if 8080 is unavailable.

Check the application and logs:

```sh
curl -fsS http://localhost:8080/health
docker compose --env-file .env.selfhost -f compose.selfhost.yml logs --tail=100 api web
```

Stop it without removing stored data:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml down
```

Do not add `--volumes` to that command unless you intend to delete the PostgreSQL volume.

### Access from another machine

Keep the Docker web port bound to loopback and put an HTTPS reverse proxy on the same host in front of `127.0.0.1:8080`. Forward normal HTTP requests and WebSocket upgrades. Set `WOOBLE_ORIGIN` to the exact browser origin, such as `https://wooble.example.com`, then recreate the API service:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --force-recreate api
```

The proxy must terminate HTTPS. Session cookies are Secure for non-local production origins. Wooble currently lacks email verification, email delivery, and password recovery. Keep access to the installation within a trusted group until those flows are available; do not invite people by an unverified email address.

### Backup and updates

The `postgres-data` Docker volume contains Wooble's durable application data. Save a database backup before updating:

```sh
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T postgres \
  pg_dump -U wooble -Fc wooble > wooble-backup.dump
```

Store the backup outside the server as well. After updating the checkout, run the same `up --build -d` command. The migration service applies pending migrations before the API starts. Test a restore on a separate installation before depending on backups for recovery.

## Bun on the host

Prerequisites: Bun 1.3.14, PostgreSQL 16, and a web server or reverse proxy capable of serving static files and forwarding WebSocket connections. Create a PostgreSQL database and user with a strong password. From the repository root:

```sh
bun install --frozen-lockfile
cp .env.example .env
```

Set `DATABASE_URL` to the database you created, `API_PORT=3001`, `NODE_ENV=production`, and `WEB_ORIGIN` to the browser origin. For a same-machine trial through a web server on port 8080, use `WEB_ORIGIN=http://localhost:8080`. Keep `.env` private. Apply migrations and build the frontend:

```sh
bun db:migrate
bun run --cwd apps/web build
bun --env-file=.env apps/api/src/index.ts
```

Run the final command under a process supervisor so it restarts after a reboot. Serve `apps/web/dist` as a single-page app: return `index.html` for UI routes, proxy `/api/*` and `/health` to `127.0.0.1:3001`, and allow WebSocket upgrades on `/api/canvases/*/live`. Bind or firewall the API port so clients reach it only through the proxy. Set the proxy's public URL to exactly the same value as `WEB_ORIGIN`.

For Internet access, use HTTPS at the reverse proxy. The same account and email limitations described above apply. Back up the PostgreSQL database before applying migrations or updating the application.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection used by the API and migrations |
| `API_PORT` | API listener port; defaults to 3001 |
| `WEB_ORIGIN` | Exact browser origin accepted for credentials, writes, and WebSockets |
| `NODE_ENV` | Set to `production` for a self-hosted API |
| `TRUST_PROXY` | Set to `true` only when the API is reachable solely through a proxy that controls `X-Forwarded-For`; the Docker stack sets this automatically |
| `WOOBLE_DB_PASSWORD` | Password used by the Docker PostgreSQL service |
| `WOOBLE_ORIGIN` | Docker setting that becomes `WEB_ORIGIN` |
| `WOOBLE_HTTP_PORT` | Local Docker web port; defaults to 8080 |

`VITE_API_URL` should remain empty for the same-origin deployments described here. It is embedded into the frontend at build time. A separate API origin requires rebuilding the web app and configuring CORS and cookies for that origin.
