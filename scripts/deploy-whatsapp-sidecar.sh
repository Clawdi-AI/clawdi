#!/usr/bin/env bash
set -euo pipefail

readonly sidecar_service="clawdi-whatsapp-baileys"
readonly infra_service="clawdi-whatsapp-netns"
readonly tailscale_service="clawdi-whatsapp-tailscale"
readonly guard_service="clawdi-whatsapp-egress-guard"
readonly sidecar_image="ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:${DEPLOY_IMAGE_VERSION}"

remote_value() {
	kamal server exec "printf 'CLAWDI_VALUE=%s\\n' \"\$($1)\"" 2>/dev/null |
		sed -n 's/^.*CLAWDI_VALUE=//p' | tail -n 1 || true
}

container_field() {
	remote_value "docker container inspect --format '$1' '$2'"
}

container_netns_inode() {
	local pid
	pid="$(container_field '{{.State.Pid}}' "$1")"
	[[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 0
	remote_value "stat -Lc %i /proc/${pid}/ns/net"
}

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
		'registry.k8s.io/pause:3.10.1@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c' \
		'tailscale/tailscale:v1.98.10@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0' \
		'kernel-netns-uid-killswitch-v1' \
		"${WHATSAPP_TAILSCALE_EXIT_NODE}" | sha256sum | cut -d ' ' -f 1)"
	export WHATSAPP_TAILSCALE_CONFIG_REVISION
elif [[ -n "${WHATSAPP_TAILSCALE_EGRESS_ENABLED:-}" && "${WHATSAPP_TAILSCALE_EGRESS_ENABLED}" != false ]]; then
	echo "WHATSAPP_TAILSCALE_EGRESS_ENABLED must be exactly true or false/unset" >&2
	exit 1
fi

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

current_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-sidecar.deployment-revision" }}' "${sidecar_service}")"
actual_network="$(container_field '{{.HostConfig.NetworkMode}}' "${sidecar_service}")"
desired_network=bridge
[[ "${egress_enabled}" == true ]] && desired_network="container:${infra_service}"
sidecar_needs_reboot=false
[[ "${current_revision}" == "${SIDECAR_REVISION}" ]] || sidecar_needs_reboot=true
[[ "${actual_network}" == "${desired_network}" ]] || sidecar_needs_reboot=true

if [[ "${egress_enabled}" == true ]]; then
	kamal accessory directories whatsapp-tailscale
	kamal accessory directories whatsapp-egress-guard
	kamal server exec \
		"printf 'nameserver 100.100.100.100\\noptions timeout:2 attempts:2\\n' > \
		 /home/phala/clawdi-whatsapp/tailscale-resolv.conf && \
		 chmod 644 /home/phala/clawdi-whatsapp/tailscale-resolv.conf"

	infra_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-netns.config-revision" }}' "${infra_service}")"
	infra_running="$(container_field '{{.State.Running}}' "${infra_service}")"
	if [[ "${infra_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${infra_running}" != true ]]; then
		# Docker does not propagate an owner netns restart to joined containers.
		# Stop every consumer before replacing the namespace owner.
		kamal accessory stop whatsapp-baileys >/dev/null 2>&1 || true
		kamal accessory stop whatsapp-egress-guard >/dev/null 2>&1 || true
		kamal accessory stop whatsapp-tailscale >/dev/null 2>&1 || true
		kamal accessory reboot whatsapp-netns
		sidecar_needs_reboot=true
	fi

	infra_inode="$(container_netns_inode "${infra_service}")"
	[[ "${infra_inode}" =~ ^[0-9]+$ ]] || { echo "WhatsApp infra network namespace is unavailable" >&2; exit 1; }
	tailscale_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${tailscale_service}")"
	tailscale_inode="$(container_netns_inode "${tailscale_service}")"
	if [[ "${tailscale_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${tailscale_inode}" != "${infra_inode}" ]]; then
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
	[[ "$(container_netns_inode "${tailscale_service}")" == "${infra_inode}" ]] || { echo "Tailscale network namespace drifted" >&2; exit 1; }

	guard_revision="$(container_field '{{ index .Config.Labels "io.clawdi.whatsapp-egress.config-revision" }}' "${guard_service}")"
	guard_inode="$(container_netns_inode "${guard_service}")"
	if [[ "${guard_revision}" != "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" || "${guard_inode}" != "${infra_inode}" ]]; then
		kamal accessory reboot whatsapp-egress-guard
	fi
	guard_ready=false
	for _attempt in $(seq 1 12); do
		if kamal accessory exec whatsapp-egress-guard --reuse \
			"iptables -C OUTPUT -m owner --uid-owner 1000 -j CLAWDI_WA_EGRESS && \
			 iptables -C CLAWDI_WA_EGRESS -o tailscale0 -j ACCEPT && \
			 iptables -C CLAWDI_WA_EGRESS -j REJECT && \
			 ip6tables -C OUTPUT -m owner --uid-owner 1000 -j CLAWDI_WA_EGRESS" \
			>/dev/null 2>&1; then
			guard_ready=true
			break
		fi
		sleep 2
	done
	[[ "${guard_ready}" == true ]] || { echo "WhatsApp UID egress guard failed readiness" >&2; exit 1; }
	[[ "$(container_netns_inode "${guard_service}")" == "${infra_inode}" ]] || { echo "Egress guard network namespace drifted" >&2; exit 1; }

	# Run as the production UID in the exact shared namespace. This is a native
	# fetch with no proxy dispatcher, so it covers the transparent network path.
	observed_ip="$(remote_value "docker run --rm --network container:${infra_service} --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true --volume /home/phala/clawdi-whatsapp/tailscale-resolv.conf:/etc/resolv.conf:ro --entrypoint node ${sidecar_image} -e \"fetch('https://api.ipify.org').then(async r=>{if(!r.ok)throw Error(String(r.status));process.stdout.write((await r.text()).trim())}).catch(e=>{console.error(e);process.exit(1)})\"")"
	[[ "${observed_ip}" == "${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP}" ]] || { echo "WhatsApp Tailscale public IP preflight failed" >&2; exit 1; }
	[[ "$(container_netns_inode "${sidecar_service}")" == "${infra_inode}" ]] || sidecar_needs_reboot=true
fi

if [[ "${sidecar_needs_reboot}" == true ]]; then
	kamal accessory reboot whatsapp-baileys
	kamal server exec \
		"test \"\$(docker container inspect --format '{{.Config.Image}}' '${sidecar_service}')\" = '${sidecar_image}'"
fi

if [[ "${egress_enabled}" == true ]]; then
	infra_inode="$(container_netns_inode "${infra_service}")"
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
