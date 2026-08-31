#!/bin/sh
set -eu

if [ -n "${CLAWDI_DESKTOP_SMOKE_LOG_FILE:-}" ]; then
	printf '%s\n' "$*" >> "$CLAWDI_DESKTOP_SMOKE_LOG_FILE"
fi

case "$1 ${2:-}" in
	"update --native-identity")
		printf '0.14.32\tdarwin-arm64\n'
		;;
	"auth status")
		printf '%s\n' '{"authenticated":false,"source":"none"}'
		;;
	"daemon doctor")
		printf '%s\n' '{"singleton_unit_installed":true,"agents":[{"heartbeat":{"status":"live"}}]}'
		;;
	"agent detect")
		printf '%s\n' '{"agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":true,"version":"1.0.0","inspection":"complete"}]}'
		;;
	*)
		printf 'Unexpected smoke command: %s\n' "$*" >&2
		exit 2
		;;
esac
