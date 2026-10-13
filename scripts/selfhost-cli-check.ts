import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "../deploy/wooble"), "utf8");
const required = [
  "umask 077",
  "date -u +%Y%m%dT%H%M%SZ",
  "--confirm",
  "pg_dump -U wooble -Fc wooble",
  "pg_restore --clean --if-exists --no-owner",
  "compose run --rm migrate",
  "docker volume inspect",
  "com.docker.compose.volume",
  "com.docker.compose.project",
  "multiple matching Wooble postgres-data volumes found",
  "invalid matching Wooble postgres-data volume labels found",
  "WOOBLE_LEGACY_PROJECT_NAME",
  "pre-restore backup",
  "WOOBLE_COMPOSE_PROJECT_NAME",
  "duplicate self-host settings in env file",
  'export WOOBLE_VERSION="$1"',
];
const missing = required.filter((needle) => !source.includes(needle));
if (missing.length) throw new Error(`Self-host CLI invariants missing: ${missing.join(", ")}`);
if (/docker\s+(?:system\s+prune|volume\s+rm|compose\s+down\s+--volumes)/.test(source)) {
  throw new Error("Self-host CLI contains a destructive blanket cleanup command");
}
console.log(`Self-host CLI static checks passed (${required.length} invariants)`);
