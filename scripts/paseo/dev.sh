#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/paseo/common.sh
. "$SCRIPT_DIR/common.sh"
require_paseo_setup
load_paseo_ports

WEB_RUNTIME_PORT="${WEB_PORT}"
BACKEND_RUNTIME_PORT="${BACKEND_PORT}"
WEB_BIND_HOST="${HOST:-0.0.0.0}"
API_BIND_HOST="${HOST:-0.0.0.0}"
WEB_URL="${WEB_PUBLIC_URL:-http://localhost:${WEB_RUNTIME_PORT}}"
API_URL="${API_PUBLIC_URL:-http://localhost:${BACKEND_RUNTIME_PORT}}"
CORS_ORIGINS="$(
  json_string_array \
    "$WEB_URL" \
    "http://localhost:${WEB_RUNTIME_PORT}" \
    "http://127.0.0.1:${WEB_RUNTIME_PORT}"
)"
DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_dev@127.0.0.1:${PG_PORT}/clawdi"

export COMPOSE_PROJECT_NAME
export INFRA_POSTGRES_HOST=127.0.0.1
export INFRA_POSTGRES_PORT="${PG_PORT}"
export INFRA_POSTGRES_DB=clawdi
export INFRA_POSTGRES_USER=clawdi
export INFRA_POSTGRES_PASSWORD=clawdi_dev

export DATABASE_URL
export DEBUG=true
export PUBLIC_API_URL="$API_URL"
export WEB_ORIGIN="$WEB_URL"
export CORS_ORIGINS
export NEXT_PUBLIC_API_URL="$API_URL"

docker compose up -d --wait postgres
run_backend_migrations

pids=()

cleanup() {
  trap - EXIT INT TERM
  if [ "${#pids[@]}" -gt 0 ]; then
    kill "${pids[@]}" >/dev/null 2>&1 || true
    wait "${pids[@]}" >/dev/null 2>&1 || true
  fi
  docker compose down >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

(
  cd apps/web
  NEXT_PUBLIC_API_URL="$API_URL" bun run dev -- --hostname "$WEB_BIND_HOST" --port "$WEB_RUNTIME_PORT"
) &
pids+=("$!")

(
  cd backend
  DATABASE_URL="$DATABASE_URL" \
    DEBUG=true \
    PUBLIC_API_URL="$API_URL" \
    WEB_ORIGIN="$WEB_URL" \
    CORS_ORIGINS="$CORS_ORIGINS" \
    uv run uvicorn app.main:app --reload --host "$API_BIND_HOST" --port "$BACKEND_RUNTIME_PORT"
) &
pids+=("$!")

set +e
wait -n "${pids[@]}"
status=$?
set -e
exit "$status"
