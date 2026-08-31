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
	"agent detect")
		printf '%s\n' '{"agents":[{"type":"codex","displayName":"Codex","detected":true,"registered":true,"version":"1.0.0","inspection":"complete"}]}'
		;;
	"session list")
		printf '%s\n' '[{"id":"smoke-session","agent":"codex","agent_name":"Codex","project":"/Users/smoke/clawdi","started_at":"2026-08-31T09:00:00.000Z","ended_at":"2026-08-31T09:05:00.000Z","message_count":2,"duration_seconds":300,"model":"gpt-5","summary":"Fix local-first dashboard"}]'
		;;
	"session read-local")
		printf '%s\n' '{"schema_version":"clawdi.desktopLocalSession.v1","session":{"id":"smoke-session","agent":"codex","agent_name":"Codex","project":"/Users/smoke/clawdi","started_at":"2026-08-31T09:00:00.000Z","ended_at":"2026-08-31T09:05:00.000Z","message_count":2,"duration_seconds":300,"model":"gpt-5","summary":"Fix local-first dashboard"},"messages":[{"role":"user","content":"Keep the dashboard on this Mac.","model":null,"timestamp":"2026-08-31T09:00:00.000Z"},{"role":"assistant","content":"Local session rendering is ready.","model":"gpt-5","timestamp":"2026-08-31T09:05:00.000Z"}]}'
		;;
	*)
		printf 'Unexpected smoke command: %s\n' "$*" >&2
		exit 2
		;;
esac
