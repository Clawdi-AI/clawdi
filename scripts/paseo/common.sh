#!/usr/bin/env bash

require_paseo_setup() {
  local missing=()

  [ -f .paseo/ports.env ] || missing+=(".paseo/ports.env")
  [ -f apps/web/.env.local ] || missing+=("apps/web/.env.local")
  [ -f backend/.env ] || missing+=("backend/.env")

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Paseo setup has not been run for this worktree." >&2
    echo "Missing: ${missing[*]}" >&2
    echo "Run: bash scripts/paseo/setup.sh" >&2
    exit 1
  fi
}

load_paseo_ports() {
  if [ -f .paseo/ports.env ]; then
    set -a
    # shellcheck disable=SC1091
    . .paseo/ports.env
    set +a
  fi

  DEV_PORT="${DEV_PORT:-${WEB_PORT:-3000}}"
  WEB_PORT="${WEB_PORT:-$DEV_PORT}"
  BACKEND_PORT="${BACKEND_PORT:-$((WEB_PORT + 1))}"
  PG_PORT="${PG_PORT:-$((WEB_PORT + 2))}"
  COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clawdi-${WEB_PORT}}"
}

json_string_array() {
  python3 - "$@" <<'PY'
import json
import sys

seen = set()
values = []
for value in sys.argv[1:]:
    value = value.strip()
    if not value or value in seen:
        continue
    seen.add(value)
    values.append(value)

print(json.dumps(values, separators=(",", ":")))
PY
}

run_backend_migrations() {
  (cd backend && DATABASE_URL="$DATABASE_URL" uv run alembic upgrade head)
}
