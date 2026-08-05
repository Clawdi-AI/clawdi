#!/usr/bin/env bash
set -euo pipefail

readonly sidecar_service="clawdi-whatsapp-baileys"
readonly infra_service="clawdi-whatsapp-netns"
readonly tailscale_service="clawdi-whatsapp-tailscale"
readonly guard_service="clawdi-whatsapp-egress-guard"
readonly sidecar_image="ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:${DEPLOY_IMAGE_VERSION}"
readonly tailscale_image="tailscale/tailscale:v1.98.10@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0"
readonly whatsapp_host_root="/home/phala/clawdi-whatsapp"
readonly sidecar_state_dir="${whatsapp_host_root}/state"
readonly sidecar_run_dir="${whatsapp_host_root}/run"
readonly tailscale_state_dir="${whatsapp_host_root}/tailscale-state"
readonly guard_state_dir="${whatsapp_host_root}/egress-guard"
readonly tailscale_resolver_file="${whatsapp_host_root}/tailscale-resolv.conf"

remote_value() {
	kamal server exec "printf 'CLAWDI_VALUE=%s\\n' \"\$($1)\"" 2>/dev/null |
		sed -n 's/^.*CLAWDI_VALUE=//p' | tail -n 1 || true
}

container_field() {
	remote_value "docker container inspect --format '$1' '$2'"
}

container_netns_inode() {
	remote_value "docker exec '$1' stat -Lc %i /proc/self/ns/net"
}

validate_host_path() {
	local kind="$1" path="$2" expected_metadata="$3" predicate
	case "${kind}" in
		directory) predicate=-d ;;
		file) predicate=-f ;;
		*) echo "Invalid WhatsApp host path kind: ${kind}" >&2; exit 1 ;;
	esac
	case "${path}" in
		"${whatsapp_host_root}"/*) ;;
		*) echo "Refusing to validate an unexpected WhatsApp host path: ${path}" >&2; exit 1 ;;
	esac
	kamal server exec \
		"test ${predicate} '${path}' && \
		 test ! -L '${path}' && \
		 test \"\$(realpath -e '${path}')\" = '${path}' && \
		 test \"\$(stat -c '%u:%g:%a' '${path}')\" = '${expected_metadata}'"
}

infra_netns_inode() {
	remote_value "docker run --rm --network container:${infra_service} --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint stat ${tailscale_image} -Lc %i /proc/self/ns/net"
}

ensure_container_stopped() {
	local accessory="$1" service="$2" running
	running="$(container_field '{{.State.Running}}' "${service}")"
	if [[ "${running}" == true ]]; then
		kamal accessory stop "${accessory}"
		running="$(container_field '{{.State.Running}}' "${service}")"
		[[ "${running}" != true ]] || { echo "Failed to stop ${service}" >&2; exit 1; }
	elif [[ -n "${running}" && "${running}" != false ]]; then
		echo "Invalid running state for ${service}: ${running}" >&2
		exit 1
	fi
}

egress_enabled=false
if [[ "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" == true ]]; then
	egress_enabled=true
	case "${WHATSAPP_TAILSCALE_EXIT_NODE:-}" in
		""|*[!A-Za-z0-9._:-]*) echo "invalid WhatsApp Tailscale exit node" >&2; exit 1 ;;
	esac
	WHATSAPP_TAILSCALE_CONFIG_REVISION="$(printf '%s\n' \
		'registry.k8s.io/pause:3.10.1@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c' \
		"${tailscale_image}" \
		'kernel-netns-uid-killswitch-v4-runtime-permissions' \
		"${WHATSAPP_TAILSCALE_EXIT_NODE}" | sha256sum | cut -d ' ' -f 1)"
	export WHATSAPP_TAILSCALE_CONFIG_REVISION
elif [[ -n "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" && "${WHATSAPP_TAILSCALE_EGRESS_ENABLED}" != false ]]; then
	echo "WHATSAPP_TAILSCALE_EGRESS_ENABLED must be exactly true or false/unset" >&2
	exit 1
fi

kamal accessory directories whatsapp-baileys
validate_host_path directory "${sidecar_state_dir}" "1000:1000:700"
validate_host_path directory "${sidecar_run_dir}" "1000:1000:770"

current_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-sidecar.deployment-revision" }}' "${sidecar_service}")"
actual_network="$(container_field '{{.HostConfig.NetworkMode}}' "${sidecar_service}")"
sidecar_running="$(container_field '{{.State.Running}}' "${sidecar_service}")"
desired_network=bridge
infra_id=""
if [[ "${egress_enabled}" == true ]]; then
	infra_id="$(container_field '{{.Id}}' "${infra_service}")"
	desired_network="container:${infra_id}"
fi
sidecar_needs_reboot=false
[[ "${current_revision}" == "${SIDECAR_REVISION}" ]] || sidecar_needs_reboot=true
[[ "${actual_network}" == "${desired_network}" ]] || sidecar_needs_reboot=true
[[ "${sidecar_running}" == true ]] || sidecar_needs_reboot=true

if [[ "${egress_enabled}" == true ]]; then
	# A sidecar left on bridge by a previous disabled release must lose direct
	# egress before preparing the guarded Tailscale namespace.
	if [[ "${actual_network}" != "${desired_network}" ]]; then
		ensure_container_stopped whatsapp-baileys "${sidecar_service}"
	fi
	kamal accessory directories whatsapp-tailscale
	kamal accessory directories whatsapp-egress-guard
	validate_host_path directory "${tailscale_state_dir}" "1000:1000:700"
	validate_host_path directory "${guard_state_dir}" "1000:1000:700"
	kamal server exec \
		"test ! -L '${tailscale_resolver_file}' && \
		 resolver_tmp=\$(mktemp '${whatsapp_host_root}/.tailscale-resolv.conf.XXXXXX') && \
		 { printf 'nameserver 100.100.100.100\\noptions timeout:2 attempts:2\\n' > \"\$resolver_tmp\" && \
		 chmod 600 \"\$resolver_tmp\" && \
		 mv -T \"\$resolver_tmp\" '${tailscale_resolver_file}'; } || \
		 { rm -f -- \"\$resolver_tmp\"; exit 1; }"
	validate_host_path file "${tailscale_resolver_file}" "1000:1000:600"

	infra_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-netns.config-revision" }}' "${infra_service}")"
	infra_running="$(container_field '{{.State.Running}}' "${infra_service}")"
	if [[ "${infra_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${infra_running}" != true ]]; then
		# Docker does not propagate an owner netns restart to joined containers.
		# Stop every consumer before replacing the namespace owner.
		ensure_container_stopped whatsapp-baileys "${sidecar_service}"
		ensure_container_stopped whatsapp-egress-guard "${guard_service}"
		ensure_container_stopped whatsapp-tailscale "${tailscale_service}"
		kamal accessory reboot whatsapp-netns
		sidecar_needs_reboot=true
	fi

	infra_id="$(container_field '{{.Id}}' "${infra_service}")"
	[[ "${infra_id}" =~ ^[0-9a-f]{64}$ ]] || { echo "WhatsApp infra container ID is unavailable" >&2; exit 1; }
	desired_network="container:${infra_id}"
	infra_inode="$(infra_netns_inode)"
	[[ "${infra_inode}" =~ ^[0-9]+$ ]] || { echo "WhatsApp infra network namespace is unavailable" >&2; exit 1; }
	tailscale_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${tailscale_service}")"
	tailscale_network="$(container_field '{{.HostConfig.NetworkMode}}' "${tailscale_service}")"
	tailscale_inode="$(container_netns_inode "${tailscale_service}")"
	if [[ "${tailscale_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${tailscale_network}" != "${desired_network}" || "${tailscale_inode}" != "${infra_inode}" ]]; then
		kamal accessory reboot whatsapp-tailscale
	fi

	tailscale_ready=false
	for _attempt in $(seq 1 24); do
		if kamal accessory exec whatsapp-tailscale --reuse \
			"ip link show tailscale0 >/dev/null && tailscale status --json >/dev/null" \
			>/dev/null 2>&1; then
			tailscale_ready=true
			break
		fi
		sleep 5
	done
	[[ "${tailscale_ready}" == true ]] || { echo "WhatsApp Tailscale kernel interface failed readiness" >&2; exit 1; }
	[[ "$(container_field '{{.HostConfig.NetworkMode}}' "${tailscale_service}")" == "${desired_network}" ]] || { echo "Tailscale network owner drifted" >&2; exit 1; }
	[[ "$(container_netns_inode "${tailscale_service}")" == "${infra_inode}" ]] || { echo "Tailscale network namespace drifted" >&2; exit 1; }

	guard_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${guard_service}")"
	guard_network="$(container_field '{{.HostConfig.NetworkMode}}' "${guard_service}")"
	guard_inode="$(container_netns_inode "${guard_service}")"
	if [[ "${guard_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${guard_network}" != "${desired_network}" || "${guard_inode}" != "${infra_inode}" ]]; then
		kamal accessory reboot whatsapp-egress-guard
	fi
	guard_ready=false
	for _attempt in $(seq 1 12); do
		if kamal accessory exec whatsapp-egress-guard --reuse \
			"iptables -C OUTPUT -m owner --uid-owner 1000 -j CLAWDI_WA_EGRESS && \
			 iptables -C CLAWDI_WA_EGRESS -o tailscale0 -j ACCEPT && \
			 iptables -C CLAWDI_WA_EGRESS -j REJECT && \
			 ip6tables -C OUTPUT -m owner --uid-owner 1000 -j CLAWDI_WA_EGRESS && \
			 test -f /guard/network-namespace.ready && \
			 test ! -L /guard/network-namespace.ready && \
			 test \"\$(stat -c '%a' /guard/network-namespace.ready)\" = 644" \
			>/dev/null 2>&1; then
			guard_ready=true
			break
		fi
		sleep 2
	done
	[[ "${guard_ready}" == true ]] || { echo "WhatsApp UID egress guard failed readiness" >&2; exit 1; }
	[[ "$(container_field '{{.HostConfig.NetworkMode}}' "${guard_service}")" == "${desired_network}" ]] || { echo "Egress guard network owner drifted" >&2; exit 1; }
	[[ "$(container_netns_inode "${guard_service}")" == "${infra_inode}" ]] || { echo "Egress guard network namespace drifted" >&2; exit 1; }

	[[ "$(container_netns_inode "${sidecar_service}")" == "${infra_inode}" ]] || sidecar_needs_reboot=true
fi

if [[ "${sidecar_needs_reboot}" == true ]]; then
	kamal accessory reboot whatsapp-baileys
	kamal server exec \
		"test \"\$(docker container inspect --format '{{.Config.Image}}' '${sidecar_service}')\" = '${sidecar_image}'"
fi

if [[ "${egress_enabled}" == true ]]; then
	infra_inode="$(infra_netns_inode)"
	actual_network="$(container_field '{{.HostConfig.NetworkMode}}' "${sidecar_service}")"
	[[ "${actual_network}" == "${desired_network}" ]] || { echo "Baileys network owner drifted" >&2; exit 1; }
	[[ "$(container_netns_inode "${sidecar_service}")" == "${infra_inode}" ]] || { echo "Baileys network namespace drifted" >&2; exit 1; }
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
