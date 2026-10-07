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
        printf '%s\n' '{"authenticated":false,"source":"none"}'
        ;;
	"daemon doctor")
		# An authenticated Desktop must still open Dashboard when sync is intentionally stopped.
		printf '%s\n' '{"cli_version":"0.0.0-smoke","singleton_unit_installed":false,"singleton_unit_running":false,"agents":[]}'
		;;
	"agent detect")
		printf '%s\n' '{"agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":true,"version":"1.0.0","inspection":"complete"}]}'
		;;
	*)
		printf 'Unexpected smoke command: %s\n' "$*" >&2
		exit 2
		;;
esac
