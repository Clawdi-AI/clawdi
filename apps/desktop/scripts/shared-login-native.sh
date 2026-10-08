#!/bin/sh
set -eu
case "$1 ${2:-}" in
  'update --native-identity') printf '0.0.0-smoke\t%s\n' "$CLAWDI_DESKTOP_SMOKE_TARGET" ;;
  'auth status')
    if [ -f "$CLAWDI_HOME/auth.json" ]; then
      printf '%s\n' '{"authenticated":true,"credentialType":"clerk-oauth","user":{"id":"cloud_fixture","email":"fixture@example.test"}}'
    else printf '%s\n' '{"authenticated":false,"source":"none"}'; fi ;;
  'auth login')
    printf 'approval\n' >> "$CLAWDI_HOME/login-count"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopLogin.progress.v1","verificationUri":"https://accounts.clawdi.ai/device?user_code=ABCD-EFGH","userCode":"ABCD-EFGH","expiresAt":"2099-01-01T00:00:00.000Z"}' >&2
    while [ ! -f "$CLAWDI_HOME/approved" ]; do sleep 0.1; done
    printf '%s\n' '{"authType":"clerk_oauth","userId":"cloud_fixture","apiKey":"mock-only"}' > "$CLAWDI_HOME/auth.json"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopLogin.v1","status":"authenticated","user":{"id":"cloud_fixture","email":"fixture@example.test"}}' ;;
  'auth desktop-session')
    test -f "$CLAWDI_HOME/auth.json"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopSession.v1","ticket":"mock-once","expiresIn":60,"accountId":"user_fixture"}' ;;
  'auth logout') rm -f "$CLAWDI_HOME/auth.json" ;;
  'daemon doctor')
    if [ -f "$CLAWDI_HOME/sync" ]; then running=true; else running=false; fi
    printf '{"cli_version":"0.0.0-smoke","singleton_unit_installed":%s,"singleton_unit_running":%s,"agents":[]}\n' "$running" "$running" ;;
  'agent detect')
    if [ -f "$CLAWDI_HOME/sync" ]; then registered=true; else registered=false; fi
    printf '{"agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":%s,"version":"1.0.0","inspection":"complete"}]}\n' "$registered" ;;
  'agent reconnect') printf '%s\n' '{"schemaVersion":"clawdi.agentReconnectCandidates.v1","agents":[]}' ;;
  'setup --agent') : ;;
  'daemon install') touch "$CLAWDI_HOME/sync" ;;
  'daemon uninstall') rm -f "$CLAWDI_HOME/sync" ;;
  *) echo 'Unexpected mock CLI command' >&2; exit 2 ;;
esac
