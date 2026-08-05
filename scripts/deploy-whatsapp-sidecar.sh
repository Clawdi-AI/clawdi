#!/usr/bin/env bash
set -euo pipefail

readonly sidecar_service="clawdi-whatsapp-baileys"
readonly egress_service="clawdi-whatsapp-tailscale"
readonly proxy_url="http://${egress_service}:8080"

remote_inspect() {
	kamal server exec "docker container inspect --format '$1' '$2'" 2>/dev/null || true
}
last_match() { grep -Eo "$1" | tail -n 1 || true; }

egress_enabled=false
if [[ "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" == true ]]; then
	egress_enabled=true
	case "${WHATSAPP_TAILSCALE_EXIT_NODE:-}" in
		""|*[!A-Za-z0-9._:-]*) echo "invalid WhatsApp Tailscale exit node" >&2; exit 1 ;;
	esac
	if ! grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' <<< "${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP:-}"; then
		echo "WhatsApp Tailscale expected public IP must be IPv4" >&2
		exit 1
	fi
	WHATSAPP_TAILSCALE_CONFIG_REVISION="$(printf '%s\n' \
		'tailscale/tailscale:v1.98.10@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0' \
		'userspace-outbound-http-proxy-v1' \
		"${WHATSAPP_TAILSCALE_EXIT_NODE}" | sha256sum | cut -d ' ' -f 1)"
	export WHATSAPP_TAILSCALE_CONFIG_REVISION
elif [[ -n "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" && "${WHATSAPP_TAILSCALE_EGRESS_ENABLED}" != false ]]; then
	echo "WHATSAPP_TAILSCALE_EGRESS_ENABLED must be exactly true or false/unset" >&2
	exit 1
fi

kamal accessory directories whatsapp-baileys
kamal server exec \
	"test \"\$(stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/state')\" = '1000:1000:700' && \
	 test \"\$(stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/run')\" = '1000:1000:770'"
current_revision="$(remote_inspect '{{ index .Config.Labels "io.clawdi.whatsapp-sidecar.deployment-revision" }}' "${sidecar_service}" | last_match '[0-9a-f]{64}')"
actual_network="$(remote_inspect '{{.HostConfig.NetworkMode}}' "${sidecar_service}" | last_match '[A-Za-z0-9_.:-]+')"
actual_proxy="$(remote_inspect '{{range .Config.Env}}{{println .}}{{end}}' "${sidecar_service}" | grep -Eo 'CLAWDI_WA_SIDECAR_PROXY_URL=[^[:space:]]+' | tail -n 1 || true)"
desired_proxy=""
[[ "${egress_enabled}" == true ]] && desired_proxy="CLAWDI_WA_SIDECAR_PROXY_URL=${proxy_url}"
sidecar_needs_reboot=false
[[ "${current_revision}" == "${SIDECAR_REVISION}" ]] || sidecar_needs_reboot=true
[[ "${actual_network}" == kamal ]] || sidecar_needs_reboot=true
[[ "${actual_proxy}" == "${desired_proxy}" ]] || sidecar_needs_reboot=true

if [[ "${egress_enabled}" == true ]]; then
	current_egress_revision="$(remote_inspect '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${egress_service}" | last_match '[0-9a-f]{64}')"
	egress_running="$(remote_inspect '{{.State.Running}}' "${egress_service}" | last_match 'true|false')"
	if [[ "${current_egress_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${egress_running}" != true ]]; then
		kamal accessory directories whatsapp-tailscale
		kamal accessory reboot whatsapp-tailscale
	fi
	# Use the exact Undici proxy path used by Baileys native fetch. This runs
	# before replacing a direct sidecar, so a failed first cutover preserves it.
	kamal accessory exec whatsapp-baileys \
		"node /app/packages/whatsapp-baileys-sidecar/dist/egress-healthcheck.js '${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP}'"
fi

if [[ "${sidecar_needs_reboot}" == true ]]; then
	kamal accessory reboot whatsapp-baileys
fi

ready=false
for _attempt in $(seq 1 30); do
	if kamal accessory exec whatsapp-baileys --reuse \
		"node /app/packages/whatsapp-baileys-sidecar/dist/healthcheck.js" >/dev/null 2>&1; then
		ready=true
		break
	fi
	sleep 2
done
[[ "${ready}" == true ]] || { echo "WhatsApp sidecar failed readiness" >&2; exit 1; }

if [[ "${sidecar_needs_reboot}" == true ]]; then
	postgres_output="$(kamal accessory exec postgres --reuse \
		"psql -U clawdi -d clawdi -Atqc \"SELECT id::text FROM channel_accounts WHERE provider = 'whatsapp' AND visibility = 'public' AND user_id IS NULL AND status = 'active' AND archived_at IS NULL AND config->>'connection_mode' = 'baileys_managed' AND config->>'phone_number' ~ '^[1-9][0-9]{6,14}$' ORDER BY id\"")"
	managed_session_ids="$(printf '%s\n' "${postgres_output}" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' | sort -u || true)"
	for session_id in ${managed_session_ids}; do
		recovered=false
		for _attempt in $(seq 1 30); do
			if kamal accessory exec whatsapp-baileys --reuse \
				"node /app/packages/whatsapp-baileys-sidecar/dist/healthcheck.js ${session_id}" >/dev/null 2>&1; then
				recovered=true
				break
			fi
			sleep 2
		done
		[[ "${recovered}" == true ]] || { echo "Managed WhatsApp session failed post-restart recovery: ${session_id}" >&2; exit 1; }
	done
fi
