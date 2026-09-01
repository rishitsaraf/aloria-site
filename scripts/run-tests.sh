#!/usr/bin/env bash
# Runs all three suites against a local Postgres:
#   1. tests/smoke.js       — API end-to-end (needs an EMPTY database: it seeds)
#   2. tests/storefront.js  — Playwright walk of the storefront
#   3. tests/cms-audit.js   — Playwright audit of the CMS
# The browser suites reuse the data smoke seeded, so order matters.
#
#   DATABASE_URL   postgres://aloria@127.0.0.1:55432/aloria (default)
#   PORT           dev server port (default 8080)
#   CHROMIUM_PATH  optional explicit Chromium binary for playwright-core
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://aloria@127.0.0.1:55432/aloria}"
export ADMIN_EMAIL="${ADMIN_EMAIL:-admin@aloria.test}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-super-secret-admin}"
export PORT="${PORT:-8080}"
export SITE_URL="${SITE_URL:-http://localhost:$PORT}"
export BASE_URL="${BASE_URL:-http://localhost:$PORT}"

echo "── smoke (API) ──────────────────────────────"
node tests/smoke.js

echo "── dev server ───────────────────────────────"
node scripts/dev-server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 2.5

echo "── storefront (browser) ─────────────────────"
node tests/storefront.js

echo "── CMS audit (browser) ──────────────────────"
node tests/cms-audit.js

echo "ALL SUITES PASSED"
