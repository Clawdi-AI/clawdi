#!/bin/sh
set -eu

if [ -n "${CLAWDI_DESKTOP_SMOKE_LOG_FILE:-}" ]; then
	printf '%s\n' "$*" >> "$CLAWDI_DESKTOP_SMOKE_LOG_FILE"
fi

case "$1 ${2:-}" in
	"update --native-identity")
		printf '0.0.0-smoke\tdarwin-arm64\n'
		;;
	"auth status")
		if [ "${CLAWDI_DESKTOP_SMOKE_SURFACE:-install}" = "dashboard" ]; then
			printf '%s\n' '{"authenticated":true,"credentialType":"clerk-oauth","user":{"id":"smoke-user","email":"smoke@clawdi.ai"}}'
		else
			printf '%s\n' '{"authenticated":false,"source":"none"}'
		fi
		;;
	"auth desktop-session")
		printf '%s\n' '{"schemaVersion":"clawdi.desktopSession.v1","ticket":"smoke-ticket","expiresIn":60}'
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
