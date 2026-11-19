#!/usr/bin/env bash
# Creates a scratch database, applies all migrations, runs SQL parity + workflow tests, loads the seed.
# Usage: DATABASE_ADMIN_URL=postgres://postgres:pass@host:5432/postgres ./db/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ADMIN="${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
DB="salesapp_test_$$"
psql -q "$ADMIN" -c "create database $DB" >/dev/null
URL="${ADMIN%/*}/$DB"
trap 'psql -q "$ADMIN" -c "drop database if exists $DB" >/dev/null' EXIT
export PGOPTIONS='--client-min-messages=warning'
for f in db/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 "$URL" -f "$f"; done
echo "✓ migrations applied"
node scripts/sql-parity.mjs | psql -q -t -v ON_ERROR_STOP=1 "$URL" | grep -v '^\s*$'
psql -q -t -v ON_ERROR_STOP=1 "$URL" -f db/tests/10_workflow_test.sql | grep -v '^\s*$'
psql -q -v ON_ERROR_STOP=1 "$URL" -f db/seed.sql >/dev/null && echo "✓ seed loads"
