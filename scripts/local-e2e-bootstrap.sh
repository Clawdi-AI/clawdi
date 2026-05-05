#!/usr/bin/env bash
# Local end-to-end smoke test for the Phase 4a SaaS deploy flow.
#
# What it exercises:
#   1. Admin endpoint (`POST /api/admin/environments`) creates an env on
#      behalf of a brand-new clerk_id — verifies lazy user+Personal-scope
#      creation against the same code path that fires when a user clicks
#      Deploy on clawdi.ai before ever visiting cloud.clawdi.ai.
#   2. Admin endpoint (`POST /api/admin/auth/keys`) mints a deploy key
#      bound to that env. Default `scopes=null` → full account access
#      (read + write across sessions / skills / memories / vault), same
#      as a user-self-minted key. Hosted pods need this parity.
#   3. Prints env vars for running `clawdi serve` against the local
#      cloud-api so you can push real Claude Code sessions through the
#      live-sync path locally and watch them land in `cloud.clawdi.ai`'s
#      Postgres.
#
# Prereqs:
#   - cloud-api dev server up on :8000 with ADMIN_API_KEY=local-dev-admin-secret
#   - Postgres up on :5433
#   - clawdi CLI 0.5.6+ installed globally (`which clawdi`)
#
# Usage: bash scripts/local-e2e-bootstrap.sh
set -euo pipefail

ADMIN_KEY="local-dev-admin-secret"
API="http://localhost:8000"
NOVEL_CLERK_ID="user_local_e2e_$(date +%s)"

echo "=== Step 1: confirm cloud-api admin endpoint is live ==="
HEALTH=$(curl -fsS "$API/health")
echo "$HEALTH"
echo

echo "=== Step 2: register environment (lazy-creates user) ==="
ENV_RES=$(curl -fsSX POST "$API/api/admin/environments" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"target_clerk_id\":\"$NOVEL_CLERK_ID\",
    \"machine_id\":\"local-mac-$(hostname)\",
    \"machine_name\":\"local-dev\",
    \"agent_type\":\"claude_code\"
  }")
ENV_ID=$(echo "$ENV_RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "  env_id=$ENV_ID"
echo "  clerk_id=$NOVEL_CLERK_ID  (newly lazy-created — check cloud-api logs for 'admin_lazy_create_user')"
echo

echo "=== Step 3: mint deploy key bound to that env ==="
KEY_RES=$(curl -fsSX POST "$API/api/admin/auth/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"target_clerk_id\":\"$NOVEL_CLERK_ID\",
    \"label\":\"local-e2e\",
    \"environment_id\":\"$ENV_ID\"
  }")
RAW_KEY=$(echo "$KEY_RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['raw_key'])")
KEY_ID=$(echo "$KEY_RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "  key_id=$KEY_ID"
echo "  raw_key=${RAW_KEY:0:25}... (full key in env vars below)"
echo

echo "=== Step 4: verify minted key has full account access (scopes=NULL) ==="
# Empty value = NULL = full account access, identical to user-self-mint via
# Clerk JWT. Earlier rounds clamped admin-mint to a write-side allowlist —
# `f9337d1` removed that ceiling so hosted pods get parity with self-managed
# laptops (vault reads, memory reads, etc.).
PGPASSWORD=clawdi_dev psql -h localhost -p 5433 -U clawdi -d clawdi_cloud -t -c \
  "SELECT scopes FROM api_keys WHERE id='$KEY_ID';"
echo

echo "============================================================"
echo "Now run \`clawdi serve\` in a SEPARATE terminal with:"
echo "============================================================"
cat <<EOF

  export CLAWDI_AUTH_TOKEN="$RAW_KEY"
  export CLAWDI_API_URL="$API"
  export CLAWDI_ENVIRONMENT_ID="$ENV_ID"
  clawdi serve --agent claude_code

EOF
echo "============================================================"
echo "After \`serve\` is running:"
echo "  - Backfill is automatic; daemon scans ~/.claude/projects/ on startup"
echo "  - Open or continue any Claude Code conversation → new session JSONL appears"
echo "  - Daemon picks it up via fs watcher, pushes to cloud-api"
echo "  - Watch cloud-api logs for: POST /api/sessions/... 200"
echo
echo "Check pushed sessions via cloud-api API:"
echo "  curl -H \"Authorization: Bearer $RAW_KEY\" \\"
echo "       \"$API/api/sessions?environment_id=$ENV_ID\" | jq '.[] | {id, file_path}'"
echo
echo "Cleanup when done (revoke key + drop test user row):"
echo "  curl -X DELETE -H \"X-Admin-Key: $ADMIN_KEY\" \"$API/api/admin/auth/keys/$KEY_ID\""
echo "  PGPASSWORD=clawdi_dev psql -h localhost -p 5433 -U clawdi -d clawdi_cloud \\"
echo "    -c \"DELETE FROM users WHERE clerk_id='$NOVEL_CLERK_ID';\""

# Save vars to a file so user can `source` it instead of copy-pasting
ENV_FILE="/tmp/clawdi-local-e2e.env"
cat > "$ENV_FILE" <<EOF
export CLAWDI_AUTH_TOKEN="$RAW_KEY"
export CLAWDI_API_URL="$API"
export CLAWDI_ENVIRONMENT_ID="$ENV_ID"
export CLAWDI_LOCAL_E2E_KEY_ID="$KEY_ID"
export CLAWDI_LOCAL_E2E_CLERK_ID="$NOVEL_CLERK_ID"
EOF
echo
echo "Or skip the copy-paste — env vars saved to $ENV_FILE:"
echo "  source $ENV_FILE && clawdi serve --agent claude_code"
