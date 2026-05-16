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
#   - Postgres reachable through DATABASE_URL, defaulting to localhost:5433
#
# Usage:
#   docker compose up -d postgres
#   bash scripts/project-sharing-agent-bindings-demo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDM_BIN="${PDM_BIN:-pdm}"
BUN_BIN="${BUN_BIN:-bun}"
DEFAULT_DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_dev@localhost:5433/clawdi"
EFFECTIVE_DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}"

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

resolve_db_endpoint() {
  EFFECTIVE_DATABASE_URL="$EFFECTIVE_DATABASE_URL" python3 - <<'PY'
import os
from urllib.parse import urlparse

url = os.environ["EFFECTIVE_DATABASE_URL"]
parsed = urlparse(url)
host = parsed.hostname or "localhost"
port = parsed.port or 5432
print(f"{host} {port}")
PY
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
    read -r db_host db_port < <(resolve_db_endpoint)
    echo "Database endpoint: ${db_host}:${db_port}"
    if ! check_postgres "$db_host" "$db_port"; then
      ok=0
      echo "  Start the demo database with:" >&2
      echo "    docker compose up -d postgres" >&2
      echo "  Or point DATABASE_URL at a reachable test database." >&2
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
