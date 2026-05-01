#!/usr/bin/env bash
# End-to-end smoke test for `clawdi serve`.
#
# Drives the whole sync pipeline against a real backend + DB
# without involving Clerk auth. Roughly:
#
#   1. boot the backend (uvicorn) on a free port
#   2. seed a synthetic user + agent_environment + deploy api_key
#      (the seed script mints the key directly via the service
#      layer — no HTTP roundtrip, no shared internal secret)
#   3. point the CLI at a fresh ~/.clawdi/ + ~/.claude-test/ tree
#   4. run `clawdi serve` for ~12s in the background
#   5. assert: a freshly-written local skill landed on the server
#   6. assert: a server-side skill change lands back on disk
#   7. tear down (kill daemon, delete seeded rows, stop backend)
#
# Designed to be hermetic — any failure aborts via `set -e` and
# the trap removes test artifacts. Re-runnable: each invocation
# wipes the prior synthetic user before seeding.
#
# Run from the repo root:
#   scripts/serve-e2e.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
TEST_LABEL="serve_e2e"
TEST_PORT="${TEST_PORT:-18765}"
SCRATCH=$(mktemp -d -t clawdi-serve-e2e.XXXXXX)
LOG_DIR=/tmp/clawdi-serve-e2e-last
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"
BACKEND_PID=""
DAEMON_PID=""

FAILED=0
cleanup() {
  set +e
  if [ "$FAILED" = 1 ]; then
    echo
    echo "=== FAILURE — full logs at $LOG_DIR/ ==="
    echo "=== serve daemon log (last 40 lines) ==="
    tail -40 "$LOG_DIR/serve.stderr.log" 2>/dev/null
    echo "=== backend log (last 40 lines) ==="
    tail -40 "$LOG_DIR/backend.log" 2>/dev/null
  fi
  echo "[teardown] killing daemon, backend, and removing seeded user"
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  ( cd "$BACKEND_DIR" && pdm run python scripts/seed_serve_test.py --label "$TEST_LABEL" --teardown ) 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*" >&2; FAILED=1; exit 1; }

bold "1) booting backend on :$TEST_PORT"
cd "$BACKEND_DIR"
pdm run uvicorn app.main:app --host 127.0.0.1 --port "$TEST_PORT" --log-level warning \
  > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

# Wait until the health endpoint comes up; cap to 30s so a stuck
# backend doesn't hang CI forever.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$TEST_PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf "http://127.0.0.1:$TEST_PORT/health" > /dev/null \
  || fail "backend did not come up; tail of log: $(tail -20 "$LOG_DIR/backend.log")"
ok "backend up"

bold "2) seeding user + env + deploy api_key"
SEED_OUT=$(cd "$BACKEND_DIR" && pdm run python scripts/seed_serve_test.py --label "$TEST_LABEL")
USER_ID=$(grep ^USER_ID= <<<"$SEED_OUT" | cut -d= -f2)
ENV_ID=$(grep ^ENV_ID= <<<"$SEED_OUT" | cut -d= -f2)
RAW_KEY=$(grep ^RAW_KEY= <<<"$SEED_OUT" | cut -d= -f2)
[ -n "$USER_ID" ] || fail "seed script did not return USER_ID"
[ -n "$ENV_ID" ] || fail "seed script did not return ENV_ID"
[ -n "$RAW_KEY" ] || fail "seed script did not return RAW_KEY"
ok "user_id=$USER_ID env_id=$ENV_ID key=${RAW_KEY:0:16}..."

bold "3) preparing CLI scratch dirs"
export HOME="$SCRATCH/home"
export CLAUDE_CONFIG_DIR="$SCRATCH/home/.claude-test"
export CLAWDI_API_URL="http://127.0.0.1:$TEST_PORT"
export CLAWDI_AUTH_TOKEN="$RAW_KEY"
export CLAWDI_ENVIRONMENT_ID="$ENV_ID"
export CLAWDI_STATE_DIR="$SCRATCH/clawdi-state"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR/skills" "$CLAWDI_STATE_DIR"

# Plant one skill the daemon should immediately push on startup
# (initial reconcile picks it up; subsequent edits prove the
# watcher path works).
SKILL_DIR="$CLAUDE_CONFIG_DIR/skills/e2e-hello"
mkdir -p "$SKILL_DIR"
cat > "$SKILL_DIR/SKILL.md" <<EOF
---
name: e2e-hello
description: e2e seed skill
---
# Hello from e2e
EOF
ok "plant skill at $SKILL_DIR"

bold "4) starting clawdi serve in background"
cd "$REPO_ROOT"
CLAWDI_SERVE_DEBUG=1 \
  bun run packages/cli/src/index.ts serve --agent claude_code \
  > "$LOG_DIR/serve.stderr.log" 2>&1 &
DAEMON_PID=$!

# Wait for the engine.start log line so we know the daemon is
# past the env-resolution gate. 15s is plenty — the engine emits
# this within ~1s of bun startup.
for _ in $(seq 1 15); do
  if grep -q '"engine.start"' "$LOG_DIR/serve.stderr.log" 2>/dev/null; then
    break
  fi
  sleep 1
done
grep -q '"engine.start"' "$LOG_DIR/serve.stderr.log" \
  || fail "daemon never reached engine.start; log tail: $(tail -10 "$LOG_DIR/serve.stderr.log")"
ok "daemon engine started"

bold "5) verifying push: edit local skill, expect cloud row"
# Snapshot the cloud's current hash (set by the daemon's
# initialSync push at boot) so we can detect the edit's
# distinct hash, not just any non-empty value.
get_cloud_hash() {
  curl -s -o "$LOG_DIR/skill-detail.json" "http://127.0.0.1:$TEST_PORT/api/skills/e2e-hello" \
    -H "Authorization: Bearer $RAW_KEY"
  python3 -c 'import json,sys; d=json.load(open("'"$LOG_DIR/skill-detail.json"'")); print(d.get("content_hash",""))' 2>/dev/null
}
# Wait until the daemon's initialSync has uploaded the seed
# `e2e-hello` skill before we touch local files. Without this
# wait, `PREV_HASH` could be "" (skill not yet on cloud), the
# subsequent edit happens BEFORE the seed upload, and the
# detected "change" below is the seed upload itself — a
# broken watcher path could pass the test by accident.
PREV_HASH=""
for _ in $(seq 1 30); do
  PREV_HASH=$(get_cloud_hash)
  if [ -n "$PREV_HASH" ]; then break; fi
  sleep 1
done
if [ -z "$PREV_HASH" ]; then
  echo "FAIL: initialSync never uploaded e2e-hello — daemon push path broken" >&2
  exit 1
fi
# Bump the local SKILL.md so the watcher fires.
echo "# Edited at $(date +%s)" >> "$SKILL_DIR/SKILL.md"

# The watcher debounces on a sub-second window, sync engine then
# computes hash and uploads. Poll up to 45s for the cloud hash
# to CHANGE — the daemon's initialSync may have already pushed
# the unedited content at boot, so we want to confirm THIS edit
# specifically propagated, not just "something is on the cloud".
# 45s covers the poll-mode fallback path: when fs.watch is
# unavailable (overlay/FUSE filesystems, CLAWDI_SERVE_MODE=
# container), the skills watcher samples every 30s, so a 15s
# bound used to fail this step on container or sandboxed runs
# even though the daemon would have uploaded on the next tick.
CLOUD_HASH=""
for _ in $(seq 1 45); do
  CLOUD_HASH=$(get_cloud_hash)
  if [ -n "$CLOUD_HASH" ] && [ "$CLOUD_HASH" != "$PREV_HASH" ]; then break; fi
  sleep 1
done
[ -n "$CLOUD_HASH" ] && [ "$CLOUD_HASH" != "$PREV_HASH" ] || fail "edit never propagated to cloud (prev=$PREV_HASH cur=$CLOUD_HASH)
=== serve daemon log ===
$(cat "$LOG_DIR/serve.stderr.log")
=== backend log (tail) ===
$(tail -30 "$LOG_DIR/backend.log")"
ok "cloud has skill content_hash=${CLOUD_HASH:0:12}..."

bold "6) verifying pull: cloud-side change → local file"
# Upload a new version via the scope-explicit route — this
# simulates a dashboard install / marketplace push while our
# daemon is alive. The DB write fires SSE through the broker
# and our daemon receives `skill_changed` on its long-lived
# stream within ~2s.
# Read default_scope_id via the public API so the test isn't
# coupled to whichever DB name / port the operator's local
# postgres uses (the dev DB might be `clawdi_cloud`, `clawdi`,
# or whatever DATABASE_URL says). The deploy key returned by
# the seed step already has scope visibility on its bound env.
SCOPE_RESP_FILE="$LOG_DIR/scope-default.json"
SCOPE_HTTP=$(curl -s -o "$SCOPE_RESP_FILE" -w '%{http_code}' \
  "http://127.0.0.1:$TEST_PORT/api/scopes/default" \
  -H "Authorization: Bearer $RAW_KEY")
[ "$SCOPE_HTTP" = "200" ] || fail "GET /api/scopes/default returned $SCOPE_HTTP — body: $(head -c 400 "$SCOPE_RESP_FILE")"
SCOPE_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("scope_id",""))' "$SCOPE_RESP_FILE" 2>/dev/null)
[ -n "$SCOPE_ID" ] || fail "GET /api/scopes/default 200 but scope_id missing — body: $(head -c 400 "$SCOPE_RESP_FILE")"

NEW_BODY="---
name: e2e-hello
description: cloud-edited
---
# Edited from the server side at $(date +%s)
"
TAR=$(mktemp)
# COPYFILE_DISABLE=1 suppresses macOS BSD tar's AppleDouble
# `._*` resource-fork members. Without it, the server's
# archive-root validator (every member must start with
# `<skill_key>/`) rejects the upload as "archive root does not
# match skill_key" because of the spurious `._e2e-hello` entry.
( cd "$SCRATCH" && mkdir -p e2e-hello && echo "$NEW_BODY" > e2e-hello/SKILL.md && COPYFILE_DISABLE=1 tar czf "$TAR" e2e-hello && rm -rf e2e-hello )
UPLOAD_RESP="$LOG_DIR/scope-upload.json"
UPLOAD_HTTP=$(curl -s -o "$UPLOAD_RESP" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$TEST_PORT/api/scopes/$SCOPE_ID/skills/upload" \
  -H "Authorization: Bearer $RAW_KEY" \
  -F "skill_key=e2e-hello" \
  -F "file=@$TAR")
rm -f "$TAR"
[ "$UPLOAD_HTTP" = "200" ] || fail "scope-explicit upload returned $UPLOAD_HTTP — body: $(head -c 400 "$UPLOAD_RESP")"

# Daemon should pick up the SSE event within ~2s and rewrite the
# local SKILL.md. Poll for the new content marker.
LOCAL_OK=0
for _ in $(seq 1 15); do
  if grep -q "Edited from the server side" "$SKILL_DIR/SKILL.md" 2>/dev/null; then
    LOCAL_OK=1
    break
  fi
  sleep 1
done
[ "$LOCAL_OK" = 1 ] || fail "cloud→local pull did not propagate (last serve log: $(tail -20 "$LOG_DIR/serve.stderr.log"))"
ok "local SKILL.md picked up cloud edit"

bold "7) verifying delete propagation: server DELETE → local skill removed"
# Sanity check: the local dir exists right now.
[ -d "$SKILL_DIR" ] || fail "skill dir vanished before delete test (unexpected)"

# Hit the scope-explicit DELETE. The deploy key has skills:write,
# so this works.
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:$TEST_PORT/api/scopes/$SCOPE_ID/skills/e2e-hello" \
  -H "Authorization: Bearer $RAW_KEY")
[ "$HTTP_CODE" = "200" ] || fail "delete returned $HTTP_CODE, expected 200"

# Daemon should receive a `skill_deleted` SSE event and rmtree
# the local dir within ~2s. Reconcile loop is the safety net at
# 60s — give it 15s to be patient about SSE timing.
DELETE_OK=0
for _ in $(seq 1 15); do
  if [ ! -d "$SKILL_DIR" ]; then
    DELETE_OK=1
    break
  fi
  sleep 1
done
[ "$DELETE_OK" = 1 ] \
  || fail "local skill dir still exists after server delete (last serve log: $(tail -20 "$LOG_DIR/serve.stderr.log"))"
ok "local skill dir removed"

bold "8) verifying heartbeat observability fields"
# Read last_sync_at via GET /api/environments/{id}; same DB-name
# decoupling rationale as step 6.
HEARTBEAT_AGE=$(curl -sf "http://127.0.0.1:$TEST_PORT/api/environments/$ENV_ID" \
  -H "Authorization: Bearer $RAW_KEY" \
  | python3 -c '
import json, sys
from datetime import datetime, timezone
data = json.load(sys.stdin)
ts = data.get("last_sync_at")
if not ts:
    sys.exit(1)
# Strip trailing Z so fromisoformat accepts it on Pythons that
# do not auto-handle it (3.10 and earlier — current envs are
# safe, but be defensive).
ts = ts.replace("Z", "+00:00")
age = (datetime.now(timezone.utc) - datetime.fromisoformat(ts)).total_seconds()
print(int(age))
' 2>/dev/null)
[ -n "$HEARTBEAT_AGE" ] && [ "$HEARTBEAT_AGE" -lt 60 ] \
  || fail "no recent heartbeat (last_sync_at age=${HEARTBEAT_AGE}s)"
ok "heartbeat age=${HEARTBEAT_AGE}s"

bold "all checks passed"
echo
echo "Tail of daemon log (for reference):"
tail -10 "$LOG_DIR/serve.stderr.log"
