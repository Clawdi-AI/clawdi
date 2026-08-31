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
		printf '%s\n' '{"authenticated":true,"credentialType":"clerk-oauth","user":{"id":"smoke-user","email":"smoke@clawdi.local"}}'
		;;
	"daemon doctor")
		printf '%s\n' '{"singleton_unit_installed":true,"agents":[{"heartbeat":{"status":"live"}}]}'
		;;
	"auth desktop-session")
		printf '%s\n' '{"ticket":"smoke-ticket","expiresIn":60}'
		;;
	*)
		printf 'Unexpected smoke command: %s\n' "$*" >&2
		exit 2
		;;
esac
