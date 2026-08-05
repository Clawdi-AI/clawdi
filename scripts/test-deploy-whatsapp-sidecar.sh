#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
cleanup() {
	rm -rf -- "${test_root}"
}
trap cleanup EXIT

mkdir -p "${test_root}/bin"
cat > "${test_root}/bin/kamal" <<'FAKE_KAMAL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_KAMAL_LOG}"
command="$*"
case "${command}" in
	*HostConfig.NetworkMode*clawdi-whatsapp-baileys*)
		[[ "${FAKE_SCENARIO}" == transition || "${FAKE_SCENARIO}" == preflight-fail ]] && echo bridge || echo container:clawdi-whatsapp-tailscale
		;;
	*whatsapp-sidecar.deployment-revision*) echo "${SIDECAR_REVISION}" ;;
	*whatsapp-egress.config-revision*) echo "${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ;;
	*.State.Running*clawdi-whatsapp-tailscale*)
		[[ "${FAKE_SCENARIO}" == transition || "${FAKE_SCENARIO}" == preflight-fail ]] && echo false || echo true
		;;
	*.NetworkSettings.SandboxID*clawdi-whatsapp-tailscale*)
		[[ "${FAKE_SCENARIO}" == transition || "${FAKE_SCENARIO}" == preflight-fail ]] || printf '%064d\n' 1
		;;
	*.NetworkSettings.SandboxID*clawdi-whatsapp-baileys*) printf '%064d\n' 1 ;;
	*api.ipify.org*)
		[[ "${FAKE_SCENARIO}" == preflight-fail ]] && echo 198.51.100.9 || echo "${WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP}"
		;;
	*psql*) : ;;
esac
FAKE_KAMAL
chmod +x "${test_root}/bin/kamal"
printf '#!/usr/bin/env bash\nexit 0\n' > "${test_root}/bin/sleep"
chmod +x "${test_root}/bin/sleep"

run_scenario() {
	local scenario="$1"
	local enabled="$2"
	local log="${test_root}/${scenario}.log"
	local status=0
	FAKE_SCENARIO="${scenario}" \
	FAKE_KAMAL_LOG="${log}" \
	PATH="${test_root}/bin:${PATH}" \
	SIDECAR_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
	DEPLOY_IMAGE_VERSION=0123456789abcdef0123456789abcdef01234567 \
	WHATSAPP_TAILSCALE_EGRESS_ENABLED="${enabled}" \
	WHATSAPP_TAILSCALE_CONFIG_REVISION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
	WHATSAPP_TAILSCALE_EXIT_NODE=exit-node.example.ts.net \
	WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP=203.0.113.8 \
		"${repo_root}/scripts/deploy-whatsapp-sidecar.sh" >/dev/null || status=$?
	echo "${log}"
	return "${status}"
}

transition_log="$(run_scenario transition true)"
stop_line="$(grep -n 'accessory stop whatsapp-baileys' "${transition_log}" | cut -d: -f1)"
egress_line="$(grep -n 'accessory reboot whatsapp-tailscale' "${transition_log}" | cut -d: -f1)"
preflight_line="$(grep -n 'tailscale ping' "${transition_log}" | cut -d: -f1)"
sidecar_line="$(grep -n 'accessory reboot whatsapp-baileys' "${transition_log}" | cut -d: -f1)"
test "${stop_line}" -lt "${egress_line}"
test "${egress_line}" -lt "${preflight_line}"
test "${preflight_line}" -lt "${sidecar_line}"

if failure_log="$(run_scenario preflight-fail true 2>/dev/null)"; then
	echo "preflight failure unexpectedly succeeded" >&2
	exit 1
fi
grep -q 'accessory stop whatsapp-baileys' "${failure_log}"
! grep -q 'accessory reboot whatsapp-baileys' "${failure_log}"

steady_log="$(run_scenario steady true)"
grep -q 'tailscale ping' "${steady_log}"
! grep -q 'accessory stop whatsapp-baileys' "${steady_log}"
! grep -q 'accessory reboot whatsapp-tailscale' "${steady_log}"
! grep -q 'accessory reboot whatsapp-baileys' "${steady_log}"

disable_log="$(run_scenario disable false)"
grep -q 'HostConfig.NetworkMode' "${disable_log}"
grep -q 'accessory reboot whatsapp-baileys' "${disable_log}"
! grep -q 'tailscale ping' "${disable_log}"
