#!/bin/sh
set -eu
case "$1 ${2:-}" in
  'update --native-identity') printf '0.0.0-smoke\t%s\n' "$CLAWDI_DESKTOP_SMOKE_TARGET" ;;
  'auth status')
    if [ -f "$CLAWDI_HOME/auth.json" ]; then
      printf '%s\n' '{"schemaVersion":"clawdi.authStatus.v1","authenticated":true,"credentialType":"clerk-oauth","user":{"id":"cloud_fixture","email":"fixture@example.test"}}'
    else printf '%s\n' '{"schemaVersion":"clawdi.authStatus.v1","authenticated":false,"source":"none"}'; fi ;;
  'auth login')
    printf 'approval\n' >> "$CLAWDI_HOME/login-count"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopLogin.progress.v1","verificationUri":"https://accounts.clawdi.ai/device?user_code=ABCD-EFGH","userCode":"ABCD-EFGH","expiresAt":"2099-01-01T00:00:00.000Z"}' >&2
    while [ ! -f "$CLAWDI_HOME/approved" ]; do sleep 0.1; done
    printf '%s\n' '{"authType":"clerk_oauth","userId":"cloud_fixture","apiKey":"mock-only"}' > "$CLAWDI_HOME/auth.json"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopLogin.v1","status":"authenticated","user":{"id":"cloud_fixture","email":"fixture@example.test"}}' ;;
  'auth desktop-session')
    test -f "$CLAWDI_HOME/auth.json"
    if [ "$#" -gt 3 ]; then
      printf '%s\n' '{"schemaVersion":"clawdi.desktopSession.v1","status":"signed-in","expiresIn":0,"accountId":"user_fixture"}'
    else
      printf '%s\n' ticket >> "$CLAWDI_HOME/ticket-count"
      printf '%s\n' '{"schemaVersion":"clawdi.desktopSession.v1","status":"ticket","ticket":"mock-once","expiresIn":60,"accountId":"user_fixture"}'
    fi ;;
  'auth desktop-sign-out')
    test "$3" = --session-id
    test "$4" = sess_fixture
    if [ -f "$CLAWDI_HOME/fail-revoke" ]; then exit 1; fi
    printf '%s\n' revoked >> "$CLAWDI_HOME/revoked"
    printf '%s\n' '{"schemaVersion":"clawdi.desktopSignOut.v1","status":"revoked"}' ;;
  'auth logout') rm -f "$CLAWDI_HOME/auth.json" ;;
  'daemon doctor')
    if [ -f "$CLAWDI_HOME/sync" ]; then running=true; else running=false; fi
    printf '{"schemaVersion":"clawdi.daemonDoctor.v2","cli_version":"0.0.0-smoke","singleton_unit_installed":%s,"singleton_unit_running":%s,"agents":[]}\n' "$running" "$running" ;;
  'agent detect')
    if [ -f "$CLAWDI_HOME/sync" ]; then registered=true; else registered=false; fi
    printf '{"schemaVersion":"clawdi.agentDetection.v1","agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":%s,"version":"1.0.0","inspection":"complete"}]}\n' "$registered" ;;
  'agent reconnect') printf '%s\n' '{"schemaVersion":"clawdi.agentReconnectCandidates.v1","agents":[]}' ;;
  'setup --agent') : ;;
  'daemon install') touch "$CLAWDI_HOME/sync" ;;
  'daemon uninstall') rm -f "$CLAWDI_HOME/sync" ;;
  *) echo 'Unexpected mock CLI command' >&2; exit 2 ;;
esac
