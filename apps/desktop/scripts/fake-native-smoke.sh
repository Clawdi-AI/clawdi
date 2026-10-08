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
	"auth login")
		printf '%s\n' '{"schemaVersion":"clawdi.desktopLogin.progress.v1","verificationUri":"https://accounts.example.test/device?user_code=ABCD-EFGH","userCode":"ABCD-EFGH","expiresAt":"2099-01-01T00:00:00.000Z"}' >&2
		trap 'exit 0' TERM INT
		while :; do sleep 1; done
		;;
	"daemon doctor")
		# An authenticated Desktop must still start when sync is intentionally stopped.
		printf '%s\n' '{"schemaVersion":"clawdi.daemonDoctor.v2","cli_version":"0.0.0-smoke","singleton_unit_installed":false,"singleton_unit_running":false,"agents":[]}'
		;;
	"agent detect")
		printf '%s\n' '{"agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":true,"version":"1.0.0","inspection":"complete"}]}'
		;;
	*)
		printf 'Unexpected smoke command: %s\n' "$*" >&2
		exit 2
		;;
esac
