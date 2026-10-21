# Self-host Wooble

This guide describes the self-host CLI and Compose modes added after the first preview. They require a release tag that contains `deploy/wooble` and the mode overlays. The existing `v0.1.0` tag predates those files, so it is only a legacy upgrade fixture, not a checkout for this procedure. A new exact-version tag and its API/web GHCR images have not yet been verified as published. Until the maintainer publishes and verifies a tag containing these files, this is the installation procedure to use for that release, not evidence that a supported image installation is already available. Never substitute `main`, `latest`, or an untagged image.

Wooble does not yet provide email verification, email delivery, or password recovery. Keep registration and access within a trusted group. An account's email address is not verified, and a forgotten password currently has no recovery flow.

## Requirements and configuration

Use Docker Engine with the Compose plugin. When a release containing this CLI has been published, check out that exact tag (the `v0.2.0` below is a future example and must not be used until its tag and images exist), then create a private environment file:

```sh
git clone https://github.com/Dityath/Wooble.git
cd Wooble
git fetch --tags
git checkout v0.2.0
cp .env.selfhost.example .env.selfhost
chmod 600 .env.selfhost
```

Edit `.env.selfhost` and set `WOOBLE_DB_PASSWORD` to a long random alphanumeric password, `WOOBLE_VERSION` to that same exact published release tag (`v0.2.0` only after it exists), and `WOOBLE_COMPOSE_PROJECT_NAME` to a stable name for this installation. Keep the project name stable across commands so Compose reuses its database volume. Do not share or commit this file.

Choose one access mode by setting `WOOBLE_MODE`, `WOOBLE_ORIGIN`, and the mode-specific values below. The examples use port `18083` for a local instance. The checked-in environment example defaults to port `8080`; change both `WOOBLE_HTTP_PORT` and `WOOBLE_ORIGIN` together if you use another port. Caddy's local certificate is self-signed; install/trust the Caddy local root CA in the browser device, or use the browser only after explicitly allowing its local certificate. Do not disable Secure cookies to make plain HTTP work. For local Compose mode, export the disposable Caddy CA after the stack starts and import it only on devices that should trust this instance:

```sh
docker compose --env-file .env.selfhost --project-name wooble \
  -f compose.selfhost.yml -f compose.selfhost.local.yml \
  exec -T web cat /data/caddy/pki/authorities/local/root.crt > /tmp/wooble-local-root.crt
chmod 600 /tmp/wooble-local-root.crt
```

Use the configured project name in that command. Treat this CA file as trust material, not as a public certificate. Remove the local copy when it is no longer needed.

| Mode | Environment values | Browser URL and host exposure |
| --- | --- | --- |
| `local` | `WOOBLE_MODE=local`, `WOOBLE_ORIGIN=https://localhost:18083`, `WOOBLE_HTTP_PORT=18083` | `https://localhost:18083`; web binds to `127.0.0.1` only. |
| `private` | `WOOBLE_MODE=private`, `WOOBLE_BIND_ADDRESS=<host-private-IP>`, `WOOBLE_CADDY_HOST=<same-private-IP>`, `WOOBLE_ORIGIN=https://<same-private-IP>:18083`, `WOOBLE_HTTP_PORT=18083` | Exact HTTPS origin on the selected private interface. Use only on a private network/VPN and make the local Caddy certificate trusted on each device. Set the bind address to an interface address on this host. |
| `domain` | `WOOBLE_MODE=domain`, `WOOBLE_DOMAIN=wooble.example.com`, `WOOBLE_ORIGIN=https://wooble.example.com` | `https://wooble.example.com`; DNS must point to this host and inbound TCP 80/443 and UDP 443 must reach it for Caddy's automatic HTTPS/HTTP3. |

For local access, edit `.env.selfhost` to the exact published `WOOBLE_VERSION` used above, `WOOBLE_MODE=local`, `WOOBLE_ORIGIN=https://localhost:18083`, and `WOOBLE_HTTP_PORT=18083`. Set a unique project name if you need an isolated installation. The copy-and-edit workflow above avoids printing secrets. Confirm the non-secret settings without dumping the file:

```sh
awk -F= '$1 ~ /^WOOBLE_(VERSION|COMPOSE_PROJECT_NAME|MODE|ORIGIN|HTTP_PORT|DOMAIN|CADDY_HOST|BIND_ADDRESS)$/ { print }' .env.selfhost
```

The base Compose file publishes no API or database host ports. In local mode only the web container publishes `127.0.0.1:18083` in this example; private mode publishes the web port only on the explicitly selected private address; domain mode publishes web ports 80/443. Caddy sends `/api/*` and `/health` to the API, serves the static web assets, and its `reverse_proxy` carries WebSocket upgrades for live canvas connections. The API trusts forwarding headers only from the configured proxy network/CIDRs. Do not expose the API container directly or add broad trusted proxy ranges.

Run exactly one API replica against a given database. Compose sets `replicas: 1`; do not use `--scale api=N` or run a second stack against the same database. Collaboration state lives in one API process, so another instance cannot see its peers and cannot fan out authorization changes to their sockets. If another instance holds the database's single-instance claim, it logs: `Another Wooble API instance holds the single-instance claim on this database. Collaborative document sync stays disabled. Run exactly one API replica (see docs/self-hosting.md).` Stop the extra instance, then restart the remaining API so it can take the claim. A restart or crash releases the claim automatically.

Compose stores Caddy's `/data` and `/config` in named `caddy-data` and `caddy-config` volumes. Keeping the Compose project name stable preserves the local internal CA and domain ACME certificates/account state when the web container is recreated or the stack is stopped and started. Routine `down` preserves these volumes; `down --volumes` removes them along with database data. Keep the project name stable during upgrades and preserve both Caddy volumes in backups of the host's Docker volumes if you need to recover the same local CA or ACME state after host loss.

The standard API trusted range is `TRUSTED_PROXY_CIDRS=172.30.0.2/32`, the Compose Caddy peer. If you change `WOOBLE_PROXY_SUBNET`, `WOOBLE_CADDY_IP`, or `WOOBLE_API_IP`, adjust the trusted range so it names the actual Caddy peer. For an additional upstream proxy, add only its exact source CIDR to the API trusted list, and configure `CADDY_TRUSTED_PROXY_CIDRS` with the upstream proxy source ranges that Caddy should trust. The external proxy must overwrite/sanitize forwarding headers and connect through the chosen private bind. Verify the actual proxy chain and firewall before enabling these values; a client must not be able to reach the API directly and spoof `X-Forwarded-For`.

## Install and operate

The operator command loads `.env.selfhost`, selects the matching mode overlay, and uses the configured stable Compose project. `install` validates configuration, pulls the exact tagged API/web images, runs migrations, and starts the stack:

```sh
./deploy/wooble install
./deploy/wooble status
./deploy/wooble diagnose
```

`diagnose` reports mode/project/version, validates origin/bind/HTTPS settings, shows service status, and then runs three live checks, which are labelled only on failure (`[api-internal]`, `[caddy-ca]`, `[caddy-https]`, `[caddy-websocket]`): `api-internal` (the API's own health endpoint inside its container), `caddy-https` (`GET /health` over verified TLS through the Caddy `web` service, using the configured origin's host for SNI and `Host`), and `caddy-websocket` (an unauthenticated WebSocket upgrade through Caddy to `/api/canvases/<random UUID>/live`, a syntactically valid id that does not exist, with the configured `Origin`). An anonymous visitor can only open a link-shared canvas, so the API access guard itself answers this request with HTTP 401 and the JSON body `{"message":"Sign in to continue"}` before any upgrade; the probe treats that exact response, or HTTP 101, as proof the request reached the API through Caddy, and prints which one it saw. Anything else (Caddy 502/503, 404, the web app's HTML fallback, a timeout) fails. No canvas or data is touched, and the API guard is not relaxed for the probe). The Caddy probes run from the API container on the Compose network, so the host needs only Docker Compose, no curl. In local and private modes the check reads Caddy's internal CA from the `web` container (`caddy-ca` fails if it cannot) and verifies against it; TLS verification is never disabled. In domain mode it verifies against public roots, so a staging or untrusted ACME certificate fails the check. The HTTPS and WebSocket checks both run whenever the CA is available, so each failing layer is reported. When the CA cannot be read (for example, the `web` service is stopped), `diagnose` prints only `FAILED [caddy-ca]: cannot read Caddy's CA from the web container; ...; [caddy-https] and [caddy-websocket] were not checked`, then `error: diagnose found failing layers`. A failure line shows the origin only as `scheme://host[:port]`, and domain-mode origins containing credentials are rejected. On success, `diagnose` prints the API health JSON, `https probe through Caddy: HTTP 200`, `ws probe through Caddy: HTTP 401 JSON from the API access guard (request reached the API)` (or `HTTP 101` with the upgrade accepted), then `diagnose ok: ...`. Each failure line names its layer and `diagnose` exits non-zero if any layer fails. Troubleshooting note, unproven without Docker: in private mode with an IP address as `WOOBLE_CADDY_HOST`, the probe sends no SNI (TLS forbids IP literals as server names), and it has not been confirmed that Caddy's `tls internal` serves the IP's certificate to a client that sends no SNI; if `caddy-https` fails there while a browser reaches the site, treat it as a possible probe false negative and check with `docker compose logs web` and a browser before changing the proxy. The public health endpoint includes database and migration readiness plus the application version. Open the mode's browser URL from a supported device and create an account. The first account is a regular account; promoting a system administrator is a separate operation.

To start an already installed stack after a host reboot, use `./deploy/wooble up`. To inspect service logs, from the repository directory run:

```sh
docker compose --env-file .env.selfhost --project-name wooble -f compose.selfhost.yml -f compose.selfhost.local.yml logs --tail=100
```

Replace the project and mode overlay in this diagnostic command when your `.env.selfhost` differs. Stop containers while preserving data with Compose `down`:

```sh
docker compose --env-file .env.selfhost --project-name wooble -f compose.selfhost.yml -f compose.selfhost.local.yml down
```

Never add `--volumes` to routine shutdown. It deletes the database volume.

### Build from source

For a source checkout, retain the exact checked-out release/tag and the same required `WOOBLE_VERSION` metadata. Add `compose.selfhost.source.yml` after the base and access-mode files (`deploy/wooble` never uses this overlay; source builds are for CI and local validation). For example, in local mode:

```sh
docker compose --env-file .env.selfhost --project-name wooble \
  -f compose.selfhost.yml -f compose.selfhost.local.yml -f compose.selfhost.source.yml \
  config -q
docker compose --env-file .env.selfhost --project-name wooble \
  -f compose.selfhost.yml -f compose.selfhost.local.yml -f compose.selfhost.source.yml \
  up --build -d
```

For private/domain mode, substitute the matching `compose.selfhost.private.yml` or `compose.selfhost.domain.yml`. This overlay builds the API and web services from the local Dockerfile. The convenience CLI uses release images and does not select the source overlay.

## Backup, restore, and upgrade

Backups live in the repository's `backups/` directory. The CLI creates a UTC timestamped custom-format dump with a private directory and file mode (`umask 077`, file mode `0600`):

```sh
./deploy/wooble backup
```

The dump is written to a `.dump.partial` file and renamed to `.dump` only after `pg_dump` succeeds, so a file ending in `.dump` is always a complete backup; an interrupted or failed backup is removed, and any stray `*.partial` file is never a usable backup and can be deleted.

Copy each backup off the server and protect that copy with your normal encrypted storage/retention policy. A backup on the same disk is not disaster recovery. Never put database dumps in the source tree outside `backups/`; the Docker context excludes backup/dump artifacts while retaining checked-in SQL migrations.

Restore replaces database contents and requires explicit confirmation. It first stops web/API so no further writes are accepted (if they cannot be stopped, it restarts the stack and neither backs up nor restores), then takes an automatic pre-restore backup of the quiesced database (if that fails, it restarts the stack and does not restore), restores the selected dump, runs migrations, and starts the stack. If you interrupt it (Ctrl-C, SIGTERM, or SIGHUP) before the dump touches the database, the CLI restarts the stack; once the restore has begun it never replaces data on its own, leaves the stack stopped because the database may be partially restored, and prints the pre-restore backup path so you can decide how to recover. Because `pg_restore` runs inside the postgres container, it may keep running after the CLI is killed: wait for it to finish or stop it (for example, check `./deploy/wooble status` or look for the session in `pg_stat_activity`) before retrying the restore. If restore, migration, or startup fails, the CLI stops web/API, restores the automatic pre-restore dump, reruns migrations, and attempts to restart. It reports whether recovery succeeded and prints the retained backup path; it does not remove either backup. If automatic recovery also fails, the stack may remain stopped, and the pre-restore dump remains available for operator recovery:

```sh
./deploy/wooble restore --confirm backups/wooble-20261013T120000Z.dump
```

Use a real backup path in place of the fictional timestamp above. Rehearse recovery on an isolated copy before relying on it. Do not run this against an installation whose data you do not intend to replace.

Upgrade to an exact published version, never `main` or `latest`:

```sh
./deploy/wooble update v0.2.0
```

Replace `v0.2.0` with the exact target release that exists in GHCR. The command is only runnable after that exact example tag and images have been published. On success, it writes the target to `WOOBLE_VERSION` in `.env.selfhost` after migration and service start succeed, so later `up` commands keep using that version. A failed image pull, migration, or service start leaves the previous `WOOBLE_VERSION` in the env file and retains the pre-update backup. If the new stack starts but the env-file update itself fails, the CLI reports that the running stack is at the new version while the old env file remains; preserve the backup and repair the setting before the next `up`. The update makes a backup, pulls the requested API/web/migration images, applies database migrations, then starts services using the same Compose project and volume. The volume is preserved. Migration timing is before the updated API is started; migrations may be forward-only, so preserve and copy the backup off-server before an update. A migration failure reports the retained backup and leaves the current services available where possible; it does not automatically roll the schema back. Diagnose the failure first, then use the explicit confirmed restore flow if recovery is required.

When migrating a legacy v0.1.0 Compose installation, first identify the exact owner of its `postgres-data` volume using Docker's volume labels:

```sh
docker volume ls --filter label=com.docker.compose.volume=postgres-data --format '{{.Name}}'
docker volume inspect --format '{{.Name}} project={{index .Labels "com.docker.compose.project"}} logical={{index .Labels "com.docker.compose.volume"}}' <candidate-volume>
```

After confirming the intended legacy volume, set **both** `WOOBLE_COMPOSE_PROJECT_NAME` and `WOOBLE_LEGACY_PROJECT_NAME` in `.env.selfhost` to the exact Compose project owner reported by `docker volume inspect`. This directs Compose to that volume and tells the CLI which legacy owner it is permitted to validate. The CLI also verifies the logical label and expected volume name. If discovery is ambiguous or labels do not match, it refuses to guess. Resolve the install manually before retrying; do not rename or remove volumes as part of discovery.

The `install`/`update` image path and actual upgrade rehearsal are not yet demonstrated against a published image in this delivery. Do not assume a versioned image exists solely because a Git tag exists.

## Evidence checklist

Use a disposable environment for acceptance checks. Record the host, tag, commands, device, and outcome. The following remains required before claiming the complete self-host journey (#6):

- [ ] Fresh Linux host: install Docker/Compose, fetch an exact release, create a fresh `.env.selfhost`, run `deploy/wooble install`, `status`, and `diagnose`, and record health/version/migration readiness.
- [ ] Second device: from a separate device on the intended private network or public domain, open the exact HTTPS origin, register, sign out, log in again, verify the secure session cookie behavior through the browser, and open a live canvas.
- [ ] Domain HTTPS: verify DNS, automatic certificate issuance/renewal configuration, browser login, and WebSocket operation using a controlled domain.
- [ ] Backup recovery: make a fictional-content backup, rehearse `restore --confirm` on a disposable volume, and verify the content after restore and migrations.
- [ ] Upgrade: install the previous-release fixture, record content, update to the exact next release on the same volume, and verify content plus health.

At this documentation checkpoint, no fresh Linux host, second device, controlled domain HTTPS, local Docker/browser runtime, successful browser login through Caddy, GitHub Actions release workflow run, or multi-architecture runner result is available. These are explicitly unproven. API/WS smoke checks are not browser login evidence, and this guide does not declare issue #6 complete.
