#!/usr/bin/env bash
# Runnable local smoke for project sharing and Agent Project paths.
#
# This script executes tests that map to the live demo in:
#
#   docs/scenarios/project-sharing-agent-bindings-demo.md
#
# Prerequisites:
#   - pdm on PATH (or set PDM_BIN=/path/to/pdm)
#   - bun on PATH (or set BUN_BIN=/path/to/bun)
#   - Postgres reachable through, in priority order:
#       1. DATABASE_URL from the current shell
#       2. backend/.env
#       3. .paseo/ports.env (derives the per-worktree DB URL)
#       4. localhost:5433 dev default
#
# Usage:
#   docker compose up -d postgres
#   bash scripts/project-sharing-agent-bindings-demo.sh
#
# Safety:
#   Refuses non-local database hosts by default. Set
#   ALLOW_NONLOCAL_DATABASE_URL=1 only for an intentional disposable
#   remote test database.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDM_BIN="${PDM_BIN:-pdm}"
BUN_BIN="${BUN_BIN:-bun}"
DEFAULT_DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi"
EFFECTIVE_DATABASE_URL=""
DATABASE_URL_SOURCE=""

section() {
  printf "\n== %s ==\n" "$1"
}

require_command() {
  local bin="$1"
  local hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin" >&2
    echo "  $hint" >&2
    return 1
  fi
  return 0
}

read_env_file_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 1
  python3 - "$file" "$key" <<'PY'
import shlex
import sys
from pathlib import Path

path = Path(sys.argv[1])
target = sys.argv[2]

for raw_line in path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    if line.startswith("export "):
        line = line[len("export ") :].lstrip()

    key, value = line.split("=", 1)
    if key.strip() != target:
        continue

    value = value.strip()
    if value:
        try:
            parts = shlex.split(value, comments=True, posix=True)
        except ValueError:
            parts = []
        if len(parts) == 1:
            value = parts[0]

    if not value:
        sys.exit(1)

    print(value)
    sys.exit(0)

sys.exit(1)
PY
}

resolve_database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    EFFECTIVE_DATABASE_URL="$DATABASE_URL"
    DATABASE_URL_SOURCE="DATABASE_URL"
    return
  fi

  if EFFECTIVE_DATABASE_URL="$(read_env_file_value "$ROOT/backend/.env" DATABASE_URL)"; then
    DATABASE_URL_SOURCE="backend/.env"
    return
  fi

  local pg_port=""
  if pg_port="$(read_env_file_value "$ROOT/.paseo/ports.env" PG_PORT)" || \
     pg_port="$(read_env_file_value "$ROOT/.paseo/ports.env" INFRA_POSTGRES_PORT)"; then
    EFFECTIVE_DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_dev@127.0.0.1:${pg_port}/clawdi"
    DATABASE_URL_SOURCE=".paseo/ports.env"
    return
  fi

  EFFECTIVE_DATABASE_URL="$DEFAULT_DATABASE_URL"
  DATABASE_URL_SOURCE="default"
}

resolve_db_endpoint() {
  EFFECTIVE_DATABASE_URL="$EFFECTIVE_DATABASE_URL" python3 - <<'PY'
import os
import sys
from urllib.parse import urlparse

url = os.environ["EFFECTIVE_DATABASE_URL"]
parsed = urlparse(url)
host = parsed.hostname or "localhost"
try:
    port = parsed.port or 5432
except ValueError as exc:
    print(f"Invalid database URL port: {exc}", file=sys.stderr)
    sys.exit(1)
print(f"{host} {port}")
PY
}

is_loopback_host() {
  local host="$1"
  python3 - "$host" <<'PY'
import ipaddress
import socket
import sys

host = sys.argv[1]
if host == "localhost":
    sys.exit(0)

try:
    if ipaddress.ip_address(host).is_loopback:
        sys.exit(0)
except ValueError:
    pass

try:
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
except OSError:
    sys.exit(1)

for info in infos:
    address = info[4][0]
    try:
        if ipaddress.ip_address(address).is_loopback:
            sys.exit(0)
    except ValueError:
        pass

sys.exit(1)
PY
}

require_local_database() {
  local host="$1"
  if is_loopback_host "$host"; then
    return
  fi

  if [ "${ALLOW_NONLOCAL_DATABASE_URL:-}" = "1" ]; then
    echo "Database safety: non-local host allowed by ALLOW_NONLOCAL_DATABASE_URL=1"
    return
  fi

  echo "Refusing to run demo smoke against non-local database host: $host" >&2
  echo "Set ALLOW_NONLOCAL_DATABASE_URL=1 only for an intentional disposable remote test database." >&2
  exit 1
}

check_postgres() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
try:
    with socket.create_connection((host, port), timeout=2):
        pass
except OSError as exc:
    print(f"Postgres is not reachable at {host}:{port}: {exc}", file=sys.stderr)
    sys.exit(1)
PY
}

preflight() {
  section "Preflight"
  local ok=1
  require_command "$PDM_BIN" "Install pdm or set PDM_BIN=/path/to/pdm." || ok=0
  require_command "$BUN_BIN" "Install bun or set BUN_BIN=/path/to/bun." || ok=0
  require_command python3 "Install Python 3 for the Postgres reachability check." || ok=0

  if [[ "$ok" -eq 1 ]]; then
    resolve_database_url
    read -r db_host db_port < <(resolve_db_endpoint)
    echo "Database source: ${DATABASE_URL_SOURCE}"
    echo "Database endpoint: ${db_host}:${db_port}"
    require_local_database "$db_host"
    if ! check_postgres "$db_host" "$db_port"; then
      ok=0
      echo "  Start the demo database with:" >&2
      echo "    docker compose up -d postgres" >&2
      echo "  Or point DATABASE_URL / backend/.env / .paseo/ports.env at a reachable test database." >&2
    fi
  fi

  if [[ "$ok" -ne 1 ]]; then
    echo "" >&2
    echo "Demo smoke preflight failed; fix the prerequisite above and re-run." >&2
    exit 1
  fi
}

section "Project sharing + Agent Project demo smoke"
echo "Repository: $ROOT"
echo "Story: project owner shares -> recipient accepts -> agent uses project -> vault provenance -> revoke cleanup"

preflight

section "Backend role paths"
(
  cd "$ROOT/backend"
  DATABASE_URL="$EFFECTIVE_DATABASE_URL" "$PDM_BIN" run pytest \
    tests/test_project_agent_role_paths.py \
    tests/test_me_routes.py \
    tests/test_share_redeem_routes.py \
    tests/test_sharing_create_link.py \
    tests/test_sharing_invitations.py \
    tests/test_sharing_list_revoke.py \
    tests/test_agent_project_bindings_routes.py \
    tests/test_project_visibility_shared.py \
    tests/test_vault.py \
    tests/test_skills.py \
    -q
)

section "CLI user and agent contracts"
(
  cd "$ROOT/packages/cli"
  "$BUN_BIN" test \
    tests/commands/agent-projects.test.ts \
    tests/commands/auth.test.ts \
    tests/commands/inbox.test.ts \
    tests/commands/project-create.test.ts \
    tests/commands/project-list.test.ts \
    tests/commands/project-members.test.ts \
    tests/commands/project-sharing-owner.test.ts \
    tests/commands/project-show.test.ts \
    tests/project-folders.test.ts \
    tests/commands/run.test.ts \
    tests/commands/pull.test.ts \
    tests/commands/push.test.ts \
    tests/commands/vault-resolve.test.ts
)

section "Demo smoke passed"
echo "Use docs/scenarios/project-sharing-agent-bindings-demo.md as the human-facing walkthrough."
