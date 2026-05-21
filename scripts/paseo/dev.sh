#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/paseo/common.sh
. "$SCRIPT_DIR/common.sh"
require_paseo_setup
REQUESTED_WEB_PUBLIC_URL="${WEB_PUBLIC_URL:-}"
REQUESTED_API_PUBLIC_URL="${API_PUBLIC_URL:-}"
load_paseo_ports

WEB_RUNTIME_PORT="${WEB_PORT}"
BACKEND_RUNTIME_PORT="${BACKEND_PORT}"
WEB_BIND_HOST="${HOST:-0.0.0.0}"
API_BIND_HOST="${HOST:-0.0.0.0}"
WEB_URL="${REQUESTED_WEB_PUBLIC_URL:-${WEB_PUBLIC_URL:-http://localhost:${WEB_RUNTIME_PORT}}}"
API_URL="${REQUESTED_API_PUBLIC_URL:-${API_PUBLIC_URL:-http://localhost:${BACKEND_RUNTIME_PORT}}}"
WEB_PUBLIC_HOST="$(
  python3 - "$WEB_URL" <<'PY'
import sys
from urllib.parse import urlparse

print(urlparse(sys.argv[1]).hostname or "")
PY
)"
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

export WEB_PUBLIC_URL="$WEB_URL"
export API_PUBLIC_URL="$API_URL"
export DATABASE_URL
export DEBUG=true
export PUBLIC_API_URL="$API_URL"
export WEB_ORIGIN="$WEB_URL"
export CORS_ORIGINS
export NEXT_PUBLIC_API_URL="$API_URL"
export NEXT_PUBLIC_CLAWDI_HOSTED="${NEXT_PUBLIC_CLAWDI_HOSTED:-}"
export NEXT_PUBLIC_DEPLOY_API_URL="${NEXT_PUBLIC_DEPLOY_API_URL:-http://localhost:50021}"
DEV_AUTH_BYPASS="${DEV_AUTH_BYPASS:-true}"
case "$WEB_PUBLIC_HOST" in
  ""|"localhost"|"127.0.0.1")
    ;;
  *)
    export NEXT_ALLOWED_DEV_ORIGINS="${NEXT_ALLOWED_DEV_ORIGINS:-$WEB_PUBLIC_HOST}"
    ;;
esac
if [ "${DEV_AUTH_BYPASS:-}" = "true" ]; then
  export DEV_AUTH_TOKEN="${DEV_AUTH_TOKEN:-dev-bypass}"
  export DEV_AUTH_CLERK_ID="${DEV_AUTH_CLERK_ID:-dev_browser}"
  export DEV_AUTH_EMAIL="${DEV_AUTH_EMAIL:-dev@clawdi.local}"
  export DEV_AUTH_NAME="${DEV_AUTH_NAME:-Dev User}"
  export NEXT_PUBLIC_DEV_AUTH_BYPASS="${NEXT_PUBLIC_DEV_AUTH_BYPASS:-true}"
  export NEXT_PUBLIC_DEV_AUTH_TOKEN="${NEXT_PUBLIC_DEV_AUTH_TOKEN:-$DEV_AUTH_TOKEN}"
fi

docker compose up -d --wait postgres
run_backend_migrations

pids=()
backend_dev_auth_env=()
if [ -n "${DEV_AUTH_BYPASS:-}" ]; then
  backend_dev_auth_env+=("DEV_AUTH_BYPASS=${DEV_AUTH_BYPASS}")
fi
if [ -n "${DEV_AUTH_TOKEN:-}" ]; then
  backend_dev_auth_env+=("DEV_AUTH_TOKEN=${DEV_AUTH_TOKEN}")
fi
if [ -n "${DEV_AUTH_CLERK_ID:-}" ]; then
  backend_dev_auth_env+=("DEV_AUTH_CLERK_ID=${DEV_AUTH_CLERK_ID}")
fi
if [ -n "${DEV_AUTH_EMAIL:-}" ]; then
  backend_dev_auth_env+=("DEV_AUTH_EMAIL=${DEV_AUTH_EMAIL}")
fi
if [ -n "${DEV_AUTH_NAME:-}" ]; then
  backend_dev_auth_env+=("DEV_AUTH_NAME=${DEV_AUTH_NAME}")
fi

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
  NEXT_PUBLIC_API_URL="$API_URL" \
    NEXT_PUBLIC_CLAWDI_HOSTED="$NEXT_PUBLIC_CLAWDI_HOSTED" \
    NEXT_PUBLIC_DEPLOY_API_URL="$NEXT_PUBLIC_DEPLOY_API_URL" \
    NEXT_PUBLIC_DEV_AUTH_BYPASS="${NEXT_PUBLIC_DEV_AUTH_BYPASS:-}" \
    NEXT_PUBLIC_DEV_AUTH_TOKEN="${NEXT_PUBLIC_DEV_AUTH_TOKEN:-}" \
    NEXT_ALLOWED_DEV_ORIGINS="${NEXT_ALLOWED_DEV_ORIGINS:-}" \
    bun run dev -- --hostname "$WEB_BIND_HOST" --port "$WEB_RUNTIME_PORT"
) &
pids+=("$!")

(
  cd backend
  env \
    DATABASE_URL="$DATABASE_URL" \
    "${backend_dev_auth_env[@]}" \
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
