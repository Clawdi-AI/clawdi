#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG:?}"
case "$1 ${2:-}" in
  "update --native-identity") printf '0.0.0-smoke\tlinux-x64\n' ;;
  "auth status") printf '%s\n' '{"authenticated":false,"source":"none"}' ;;
  "daemon doctor") printf '%s\n' '{"schemaVersion":"clawdi.daemonDoctor.v2","cli_version":"0.0.0-smoke","singleton_unit_installed":true,"singleton_unit_running":false,"agents":[]}' ;;
  "agent detect") printf '%s\n' '{"agents":[]}' ;;
  *) printf 'Unexpected update e2e CLI call: %s\n' "$*" >&2; exit 2 ;;
esac
