#!/usr/bin/env bash
set -euo pipefail

readonly sidecar_service="clawdi-whatsapp-baileys"
readonly egress_service="clawdi-whatsapp-tailscale"

if [[ "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" == true ]]; then
	case "${WHATSAPP_TAILSCALE_EXIT_NODE:-}" in
		""|*[!A-Za-z0-9._:-]*)
			echo "WHATSAPP_TAILSCALE_EXIT_NODE has an invalid format" >&2
			exit 1
			;;
	esac
	if ! grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' \
		<<< "${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP:-}"; then
		echo "WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP must be an IPv4 address" >&2
		exit 1
	fi
	WHATSAPP_TAILSCALE_CONFIG_REVISION="$(
		printf '%s\n' \
			'tailscale/tailscale:v1.98.10@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0' \
			"${WHATSAPP_TAILSCALE_EXIT_NODE}" \
			"${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP}" |
			sha256sum |
			cut -d ' ' -f 1
	)"
	export WHATSAPP_TAILSCALE_CONFIG_REVISION
elif [[ -n "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" && \
	"${WHATSAPP_TAILSCALE_EGRESS_ENABLED}" != false ]]; then
	echo "WHATSAPP_TAILSCALE_EGRESS_ENABLED must be exactly true or false/unset" >&2
	exit 1
fi

remote_inspect() {
	local format="$1"
	local service="$2"
	kamal server exec "docker container inspect --format '${format}' '${service}'" 2>/dev/null || true
}

last_match() {
	local pattern="$1"
	grep -Eo "${pattern}" | tail -n 1 || true
}

preflight_egress() {
	local observed_ip=""
	local ready=false
	for _attempt in $(seq 1 30); do
		if kamal accessory exec whatsapp-tailscale --reuse \
			"tailscale ping --timeout=10s '${WHATSAPP_TAILSCALE_EXIT_NODE}'" \
			>/dev/null 2>&1; then
			observed_ip="$(
				kamal accessory exec whatsapp-tailscale --reuse \
					"wget -qO- --timeout=10 https://api.ipify.org" 2>/dev/null |
					last_match '([0-9]{1,3}\.){3}[0-9]{1,3}'
			)"
			if [[ "${observed_ip}" == "${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP}" ]]; then
				ready=true
				break
			fi
		fi
		sleep 2
	done
	if [[ "${ready}" != true ]]; then
		echo "WhatsApp Tailscale egress failed exit-node/public-IP preflight" >&2
		return 1
	fi
}

wait_for_sidecar() {
	local session_id="${1:-}"
	local ready=false
	for _attempt in $(seq 1 30); do
		if kamal accessory exec whatsapp-baileys --reuse \
			"node /app/packages/whatsapp-baileys-sidecar/dist/healthcheck.js${session_id:+ ${session_id}}" \
			>/dev/null 2>&1; then
			ready=true
			break
		fi
		sleep 2
	done
	[[ "${ready}" == true ]]
}

kamal accessory directories whatsapp-baileys
kamal server exec \
	"test -d '/home/phala/clawdi-whatsapp/state' && \
	 test ! -L '/home/phala/clawdi-whatsapp/state' && \
	 test \"\$(realpath -e '/home/phala/clawdi-whatsapp/state')\" = '/home/phala/clawdi-whatsapp/state' && \
	 test \"\$(stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/state')\" = '1000:1000:700' && \
	 test -d '/home/phala/clawdi-whatsapp/run' && \
	 test ! -L '/home/phala/clawdi-whatsapp/run' && \
	 test \"\$(realpath -e '/home/phala/clawdi-whatsapp/run')\" = '/home/phala/clawdi-whatsapp/run' && \
	 test \"\$(stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/run')\" = '1000:1000:770'"

current_sidecar_revision="$(
	remote_inspect '{{ index .Config.Labels "io.clawdi.whatsapp-sidecar.deployment-revision" }}' "${sidecar_service}" |
		last_match '[0-9a-f]{64}'
)"
actual_network_mode="$(
	remote_inspect '{{.HostConfig.NetworkMode}}' "${sidecar_service}" |
		last_match 'bridge|container:[A-Za-z0-9_.:-]+'
)"
sidecar_needs_reboot=false
[[ "${current_sidecar_revision}" == "${SIDECAR_REVISION}" ]] || sidecar_needs_reboot=true

egress_enabled=false
desired_network_mode=bridge
egress_needs_reboot=false
egress_sandbox_id=""
if [[ "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" == true ]]; then
	egress_enabled=true
	desired_network_mode="container:${egress_service}"
	current_egress_revision="$(
		remote_inspect '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${egress_service}" |
			last_match '[0-9a-f]{64}'
	)"
	egress_running="$(remote_inspect '{{.State.Running}}' "${egress_service}" | last_match 'true|false')"
	egress_sandbox_id="$(
		remote_inspect '{{.NetworkSettings.SandboxID}}' "${egress_service}" |
			last_match '[0-9a-f]{64}'
	)"
	sidecar_sandbox_id="$(
		remote_inspect '{{.NetworkSettings.SandboxID}}' "${sidecar_service}" |
			last_match '[0-9a-f]{64}'
	)"
	[[ "${current_egress_revision}" == "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ]] || egress_needs_reboot=true
	[[ "${egress_running}" == true && -n "${egress_sandbox_id}" ]] || egress_needs_reboot=true
	case "${actual_network_mode}" in
		container:*) ;;
		*) sidecar_needs_reboot=true ;;
	esac
	[[ "${sidecar_sandbox_id}" == "${egress_sandbox_id}" ]] || sidecar_needs_reboot=true
elif [[ "${actual_network_mode}" != "${desired_network_mode}" ]]; then
	sidecar_needs_reboot=true
fi

if [[ "${egress_needs_reboot}" == true ]]; then
	sidecar_needs_reboot=true
fi
if [[ "${egress_enabled}" == true && "${sidecar_needs_reboot}" == true ]]; then
	kamal accessory stop whatsapp-baileys
fi
if [[ "${egress_needs_reboot}" == true ]]; then
	kamal accessory directories whatsapp-tailscale
	kamal accessory reboot whatsapp-tailscale
fi
if [[ "${egress_enabled}" == true ]]; then
	preflight_egress
fi
if [[ "${sidecar_needs_reboot}" == true ]]; then
	kamal accessory reboot whatsapp-baileys
	kamal server exec \
		"test \"\$(docker container inspect --format '{{.Config.Image}}' '${sidecar_service}')\" = \
		 'ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:${DEPLOY_IMAGE_VERSION}'"
else
	echo "WhatsApp sidecar inputs and network mode are unchanged; preserving the process."
fi

if ! wait_for_sidecar; then
	echo "WhatsApp sidecar failed readiness" >&2
	exit 1
fi

if [[ "${sidecar_needs_reboot}" == true ]]; then
	postgres_output="$(
		kamal accessory exec postgres --reuse \
			"psql -U clawdi -d clawdi -Atqc \"SELECT id::text FROM channel_accounts WHERE provider = 'whatsapp' AND visibility = 'public' AND user_id IS NULL AND status = 'active' AND archived_at IS NULL AND config->>'connection_mode' = 'baileys_managed' AND config->>'phone_number' ~ '^[1-9][0-9]{6,14}$' ORDER BY id\""
	)"
	managed_session_ids="$(
		printf '%s\n' "${postgres_output}" |
			grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' |
			sort -u || true
	)"
	for session_id in ${managed_session_ids}; do
		if ! wait_for_sidecar "${session_id}"; then
			echo "Managed WhatsApp session failed post-restart recovery: ${session_id}" >&2
			exit 1
		fi
	done
fi
