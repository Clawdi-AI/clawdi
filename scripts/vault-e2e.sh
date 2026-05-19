#!/usr/bin/env bash
# End-to-end smoke test for Clawdi Vault + credential profiles.
#
# Drives a real backend + real Postgres + real CLI process:
#   1. start a disposable Postgres container on a random local port
#   2. run Alembic migrations
#   3. boot uvicorn
#   4. seed a synthetic user + env-bound API key
#   5. use the CLI to import vault values, read/inject/run clawdi:// refs
#   6. use the CLI to import/materialize Codex, Claude Code, and gh credentials
#
# No real credentials are read. Every HOME / tool config path is under mktemp.
#
# Run from the repo root:
#   scripts/vault-e2e.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
TEST_LABEL="vault_e2e_$(date +%s)_$RANDOM"
TEST_PORT="${TEST_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
)}"
PG_PORT="${PG_PORT:-$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
)}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clawdi-vault-e2e-$PG_PORT}"
SCRATCH="$(mktemp -d -t clawdi-vault-e2e.XXXXXX)"
LOG_DIR="/tmp/clawdi-vault-e2e-last"
BACKEND_PID=""
FAILED=0

API_URL="http://127.0.0.1:$TEST_PORT"
DATABASE_URL="postgresql+asyncpg://clawdi:clawdi_dev@127.0.0.1:$PG_PORT/clawdi"
VAULT_E2E_KEY="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
JWT_E2E_KEY="1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100"

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

cleanup() {
  set +e
  if [ "$FAILED" = 1 ]; then
    echo
    echo "=== FAILURE — logs at $LOG_DIR/ ==="
    echo "=== backend log (last 80 lines) ==="
    tail -80 "$LOG_DIR/backend.log" 2>/dev/null
  fi
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  if [ -n "${RAW_KEY:-}" ]; then
    (
      cd "$BACKEND_DIR" &&
        DATABASE_URL="$DATABASE_URL" \
        VAULT_ENCRYPTION_KEY="$VAULT_E2E_KEY" \
        ENCRYPTION_KEY="$JWT_E2E_KEY" \
        uv run python scripts/seed_serve_test.py --label "$TEST_LABEL" --teardown
    ) >/dev/null 2>&1
  fi
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    INFRA_POSTGRES_HOST=127.0.0.1 \
    INFRA_POSTGRES_PORT="$PG_PORT" \
    INFRA_POSTGRES_DB=clawdi \
    INFRA_POSTGRES_USER=clawdi \
    INFRA_POSTGRES_PASSWORD=clawdi_dev \
    docker compose -f "$REPO_ROOT/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  ✓ %s\n" "$*"; }
fail() {
  printf "  ✗ %s\n" "$*" >&2
  FAILED=1
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_command bun
require_command curl
require_command docker
require_command python3
require_command uv

run_backend_env() {
  DATABASE_URL="$DATABASE_URL" \
    VAULT_ENCRYPTION_KEY="$VAULT_E2E_KEY" \
    ENCRYPTION_KEY="$JWT_E2E_KEY" \
    "$@"
}

run_cli() {
  local home="$1"
  local clawdi_home="$2"
  local codex_home="$3"
  local claude_home="$4"
  local gh_home="$5"
  shift 5
  HOME="$home" \
    CLAWDI_HOME="$clawdi_home" \
    CODEX_HOME="$codex_home" \
    CLAUDE_CONFIG_DIR="$claude_home" \
    GH_CONFIG_DIR="$gh_home" \
    CLAWDI_API_URL="$API_URL" \
    CLAWDI_AUTH_TOKEN="$RAW_KEY" \
    CLAWDI_NO_AUTO_UPDATE=1 \
    CLAWDI_NO_UPDATE_CHECK=1 \
    CI=true \
    NO_COLOR=1 \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    bun run "$REPO_ROOT/packages/cli/src/index.ts" "$@"
}

assert_file_equals() {
  local path="$1"
  local expected="$2"
  python3 - "$path" "$expected" <<'PY'
from pathlib import Path
import sys

actual = Path(sys.argv[1]).read_text()
expected = sys.argv[2]
if actual != expected:
    print(f"mismatch for {sys.argv[1]!r}", file=sys.stderr)
    print(f"expected: {expected!r}", file=sys.stderr)
    print(f"actual:   {actual!r}", file=sys.stderr)
    raise SystemExit(1)
PY
}

assert_no_secret_in_file() {
  local path="$1"
  local secret="$2"
  if grep -Fq "$secret" "$path"; then
    fail "$path leaked synthetic secret $secret"
  fi
}

bold "1) starting disposable Postgres on :$PG_PORT"
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
  INFRA_POSTGRES_HOST=127.0.0.1 \
  INFRA_POSTGRES_PORT="$PG_PORT" \
  INFRA_POSTGRES_DB=clawdi \
  INFRA_POSTGRES_USER=clawdi \
  INFRA_POSTGRES_PASSWORD=clawdi_dev \
  docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --wait postgres \
  >"$LOG_DIR/docker.log" 2>&1 || fail "postgres did not start; see $LOG_DIR/docker.log"
ok "postgres healthy"

bold "2) running backend migrations"
(
  cd "$BACKEND_DIR"
  run_backend_env uv run alembic upgrade head
) >"$LOG_DIR/migrations.log" 2>&1 || fail "migrations failed; see $LOG_DIR/migrations.log"
ok "migrations applied"

bold "3) booting backend on :$TEST_PORT"
(
  cd "$BACKEND_DIR"
  run_backend_env uv run uvicorn app.main:app --host 127.0.0.1 --port "$TEST_PORT" --log-level warning
) >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 30); do
  curl -sf "$API_URL/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API_URL/health" >/dev/null 2>&1 || fail "backend did not come up"
ok "backend healthy"

bold "4) seeding synthetic user + env-bound API key"
SEED_OUT=$(
  cd "$BACKEND_DIR"
  run_backend_env uv run python scripts/seed_serve_test.py --label "$TEST_LABEL" --agent-type codex
)
USER_ID="$(grep '^USER_ID=' <<<"$SEED_OUT" | cut -d= -f2)"
ENV_ID="$(grep '^ENV_ID=' <<<"$SEED_OUT" | cut -d= -f2)"
RAW_KEY="$(grep '^RAW_KEY=' <<<"$SEED_OUT" | cut -d= -f2)"
[ -n "$USER_ID" ] || fail "seed did not return USER_ID"
[ -n "$ENV_ID" ] || fail "seed did not return ENV_ID"
[ -n "$RAW_KEY" ] || fail "seed did not return RAW_KEY"
ok "seeded user_id=$USER_ID env_id=$ENV_ID"

CLI_HOME="$SCRATCH/cli-home"
CLAWDI_HOME="$SCRATCH/clawdi-state"
CODEX_HOME="$SCRATCH/codex"
CLAUDE_HOME="$SCRATCH/claude"
GH_HOME="$SCRATCH/gh"
mkdir -p "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME"

bold "5) CLI vault import + clawdi:// read/inject/run"
VAULT_SECRET="sk-vault-e2e-secret"
DATABASE_SECRET="postgres://vault-e2e"
IMPORT_ENV="$SCRATCH/import.env"
cat >"$IMPORT_ENV" <<EOF
OPENAI_API_KEY=$VAULT_SECRET
DATABASE_URL=$DATABASE_SECRET
EOF

run_cli "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME" \
  vault import "$IMPORT_ENV" --yes \
  >"$LOG_DIR/vault-import.out" 2>"$LOG_DIR/vault-import.err" \
  || fail "clawdi vault import failed"
assert_no_secret_in_file "$LOG_DIR/vault-import.out" "$VAULT_SECRET"
assert_no_secret_in_file "$LOG_DIR/vault-import.err" "$VAULT_SECRET"

run_cli "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME" \
  vault list --json \
  >"$LOG_DIR/vault-list.json" 2>"$LOG_DIR/vault-list.err" \
  || fail "clawdi vault list failed"
grep -Fq "OPENAI_API_KEY" "$LOG_DIR/vault-list.json" || fail "vault list did not include OPENAI_API_KEY"
assert_no_secret_in_file "$LOG_DIR/vault-list.json" "$VAULT_SECRET"
VAULT_PROJECT_ID="$("$(command -v bun)" -e 'const fs = require("fs"); const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const row = rows.find((v) => v.slug === "default"); if (row) console.log(row.project_id);' "$LOG_DIR/vault-list.json")"
[ -n "$VAULT_PROJECT_ID" ] || fail "could not find default vault project_id"
OPENAI_REF="clawdi://project/$VAULT_PROJECT_ID/vault/default/field/OPENAI_API_KEY"

READ_VALUE="$(
  run_cli "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME" \
    read "$OPENAI_REF" 2>"$LOG_DIR/read.err"
)"
[ "$READ_VALUE" = "$VAULT_SECRET" ] || fail "clawdi read returned unexpected value"
assert_no_secret_in_file "$LOG_DIR/read.err" "$VAULT_SECRET"

TEMPLATE="$SCRATCH/.env.template"
RENDERED="$SCRATCH/.env.local"
printf 'OPENAI_API_KEY=%s\n' "$OPENAI_REF" >"$TEMPLATE"
run_cli "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME" \
  inject --in "$TEMPLATE" --out "$RENDERED" \
  >"$LOG_DIR/inject.out" 2>"$LOG_DIR/inject.err" \
  || fail "clawdi inject failed"
assert_file_equals "$RENDERED" "OPENAI_API_KEY=$VAULT_SECRET"$'\n'
assert_no_secret_in_file "$LOG_DIR/inject.out" "$VAULT_SECRET"
assert_no_secret_in_file "$LOG_DIR/inject.err" "$VAULT_SECRET"

RUN_ENV="$SCRATCH/run.env"
printf 'OPENAI_API_KEY=%s\n' "$OPENAI_REF" >"$RUN_ENV"
CHILD_SCRIPT="if (process.env.OPENAI_API_KEY !== '$VAULT_SECRET') process.exit(42); console.log('vault-run-ok')"
run_cli "$CLI_HOME" "$CLAWDI_HOME" "$CODEX_HOME" "$CLAUDE_HOME" "$GH_HOME" \
  run --env-file "$RUN_ENV" --no-inherit-env --no-project-folder -- \
  "$(command -v bun)" -e "$CHILD_SCRIPT" \
  >"$LOG_DIR/run.out" 2>"$LOG_DIR/run.err" \
  || fail "clawdi run --env-file failed"
grep -Fq "vault-run-ok" "$LOG_DIR/run.out" || fail "child command did not confirm resolved env"
assert_no_secret_in_file "$LOG_DIR/run.out" "$VAULT_SECRET"
assert_no_secret_in_file "$LOG_DIR/run.err" "$VAULT_SECRET"
ok "vault reference flow passed"

bold "6) CLI credential profile import/materialize"
credential_case() {
  local tool="$1"
  local relative_path="$2"
  local content="$3"
  local needle="$4"
  local source_root="$SCRATCH/source-$tool"
  local dest_root="$SCRATCH/dest-$tool"
  local source_home="$source_root/home"
  local dest_home="$dest_root/home"
  local source_clawdi="$source_root/clawdi"
  local dest_clawdi="$dest_root/clawdi"
  local source_codex="$source_root/codex"
  local dest_codex="$dest_root/codex"
  local source_claude="$source_root/claude"
  local dest_claude="$dest_root/claude"
  local source_gh="$source_root/gh"
  local dest_gh="$dest_root/gh"
  local source_path=""
  local dest_path=""

  case "$tool" in
    codex)
      source_path="$source_codex/auth.json"
      dest_path="$dest_codex/auth.json"
      ;;
    claude-code)
      source_path="$source_claude/.credentials.json"
      dest_path="$dest_claude/.credentials.json"
      ;;
    gh)
      source_path="$source_gh/hosts.yml"
      dest_path="$dest_gh/hosts.yml"
      ;;
    *)
      fail "unknown credential e2e tool $tool"
      ;;
  esac

  mkdir -p "$(dirname "$source_path")" "$(dirname "$dest_path")" \
    "$source_home" "$dest_home" "$source_clawdi" "$dest_clawdi"
  printf '%s' "$content" >"$source_path"
  chmod 600 "$source_path"
  printf 'existing-local-credential' >"$dest_path"
  chmod 600 "$dest_path"

  run_cli "$source_home" "$source_clawdi" "$source_codex" "$source_claude" "$source_gh" \
    agent credentials import "$tool" --profile e2e --yes --json \
    >"$LOG_DIR/credential-$tool-import.out" 2>"$LOG_DIR/credential-$tool-import.err" \
    || fail "credential import failed for $tool"
  assert_no_secret_in_file "$LOG_DIR/credential-$tool-import.out" "$needle"
  assert_no_secret_in_file "$LOG_DIR/credential-$tool-import.err" "$needle"

  run_cli "$dest_home" "$dest_clawdi" "$dest_codex" "$dest_claude" "$dest_gh" \
    agent credentials materialize "$tool" --profile e2e --yes --json \
    >"$LOG_DIR/credential-$tool-materialize.out" 2>"$LOG_DIR/credential-$tool-materialize.err" \
    || fail "credential materialize failed for $tool"
  assert_no_secret_in_file "$LOG_DIR/credential-$tool-materialize.out" "$needle"
  assert_no_secret_in_file "$LOG_DIR/credential-$tool-materialize.err" "$needle"
  assert_file_equals "$dest_path" "$content"
  [ "$(stat -c '%a' "$dest_path")" = "600" ] || fail "$tool materialized file mode is not 600"
  compgen -G "$dest_path.bak-*" >/dev/null || fail "$tool materialize did not create backup"
}

credential_case "codex" ".codex/auth.json" '{"token":"codex-real-e2e-secret"}'$'\n' "codex-real-e2e-secret"
credential_case "claude-code" ".claude/.credentials.json" '{"accessToken":"claude-real-e2e-secret"}'$'\n' "claude-real-e2e-secret"
credential_case "gh" ".config/gh/hosts.yml" 'github.com:
  oauth_token: gh-real-e2e-secret
  user: octo
' "gh-real-e2e-secret"
ok "credential profile flow passed"

bold "Vault e2e passed"
ok "backend=$API_URL db=127.0.0.1:$PG_PORT"
