#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [ -f .paseo/ports.env ]; then
  set -a
  # shellcheck disable=SC1091
  . .paseo/ports.env
  set +a
fi

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clawdi-cloud-${PASEO_WORKTREE_PORT:-$(basename "$REPO_ROOT")}}"
INFRA_POSTGRES_PORT="${PG_PORT:-1}" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker compose down -v --remove-orphans || true
