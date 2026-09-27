#!/usr/bin/env bash
set -euo pipefail

# Runs the API test suite against a throwaway PostgreSQL database so the
# working database configured in .env is never touched.
cd "$(dirname "$0")/.."

TEST_DB_HOST="${TEST_DB_HOST:-localhost}"
TEST_DB_PORT="${TEST_DB_PORT:-5433}"
TEST_DB_NAME="${TEST_DB_NAME:-architecture_canvas_test}"
TEST_DB_USER="${TEST_DB_USER:-architecture}"
TEST_DB_PASSWORD="${TEST_DB_PASSWORD:-architecture}"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_NAME}}"
ADMIN_URL="postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/postgres"

echo "Recreating isolated test database ${TEST_DB_NAME}..."
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE);"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${TEST_DB_NAME};"

echo "Applying migrations to ${TEST_DB_NAME}..."
DATABASE_URL="${TEST_DATABASE_URL}" bun run --cwd ../../packages/db migrate

echo "Running API tests against ${TEST_DB_NAME}..."
# Explicit glob: keeps stale compiled copies under dist/tests out of the run.
DATABASE_URL="${TEST_DATABASE_URL}" bun test tests/*.test.ts
