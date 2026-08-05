#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf -- "${tmp}"' EXIT
mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/kamal" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${FAKE_LOG}"
case "$*" in
 *"accessory stop whatsapp-baileys"*)
   [[ "${SCENARIO}" == stop_failure ]] && exit 1
   [[ "${SCENARIO}" == stop_still_running ]] || touch "${FAKE_LOG}.sidecar-stopped" ;;
 *"accessory stop whatsapp-egress-guard"*) touch "${FAKE_LOG}.guard-stopped" ;;
 *"accessory stop whatsapp-tailscale"*) touch "${FAKE_LOG}.tailscale-stopped" ;;
 *"accessory reboot whatsapp-tailscale"*) touch "${FAKE_LOG}.tailscale-rebooted" ;;
 *"accessory reboot whatsapp-egress-guard"*) touch "${FAKE_LOG}.guard-rebooted" ;;
 *"accessory reboot whatsapp-baileys"*) touch "${FAKE_LOG}.sidecar-rebooted" ;;
 *"whatsapp-sidecar.deployment-revision"*)
   [[ "${SCENARIO}" == transition ]] && echo CLAWDI_VALUE=old || echo "CLAWDI_VALUE=${SIDECAR_REVISION}" ;;
 *"whatsapp-netns.config-revision"*)
   [[ "${SCENARIO}" == transition ]] && echo CLAWDI_VALUE=old || echo "CLAWDI_VALUE=${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ;;
 *"whatsapp-egress.config-revision"*) echo "CLAWDI_VALUE=${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ;;
 *"docker container inspect --format '{{.Id}}'"*) echo CLAWDI_VALUE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
 *"HostConfig.NetworkMode"*)
   if [[ "$*" != *"clawdi-whatsapp-baileys"* ]]; then
     echo CLAWDI_VALUE=container:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   elif [[ -f "${FAKE_LOG}.sidecar-rebooted" && "${SCENARIO}" != disable && "${SCENARIO}" != stopped_disabled ]]; then
     echo CLAWDI_VALUE=container:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   else
     case "${SCENARIO}" in
       reenable|preflight_fail|stop_failure|stop_still_running|stopped_disabled) echo CLAWDI_VALUE=bridge ;;
       disable) echo CLAWDI_VALUE=container:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
       *) echo CLAWDI_VALUE=container:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
     esac
   fi ;;
 *"State.Running"*"clawdi-whatsapp-baileys"*)
   if [[ -f "${FAKE_LOG}.sidecar-stopped" || "${SCENARIO}" == stopped_enabled || "${SCENARIO}" == stopped_disabled ]]; then
     echo CLAWDI_VALUE=false
   else
     echo CLAWDI_VALUE=true
   fi ;;
 *"State.Running"*"clawdi-whatsapp-egress-guard"*)
   [[ -f "${FAKE_LOG}.guard-stopped" ]] && echo CLAWDI_VALUE=false || echo CLAWDI_VALUE=true ;;
 *"State.Running"*"clawdi-whatsapp-tailscale"*)
   [[ -f "${FAKE_LOG}.tailscale-stopped" ]] && echo CLAWDI_VALUE=false || echo CLAWDI_VALUE=true ;;
 *"State.Running"*) echo CLAWDI_VALUE=true ;;
 *"docker exec"*"clawdi-whatsapp-tailscale"*"stat -Lc %i /proc/self/ns/net"*)
   if [[ -f "${FAKE_LOG}.tailscale-stopped" && ! -f "${FAKE_LOG}.tailscale-rebooted" ]]; then
     echo CLAWDI_VALUE=
   elif [[ "${SCENARIO}" == namespace_drift && ! -f "${FAKE_LOG}.tailscale-rebooted" ]]; then
     echo CLAWDI_VALUE=666
   else
     echo CLAWDI_VALUE=777
   fi ;;
 *"docker exec"*"clawdi-whatsapp-egress-guard"*"stat -Lc %i /proc/self/ns/net"*)
   [[ -f "${FAKE_LOG}.guard-stopped" && ! -f "${FAKE_LOG}.guard-rebooted" ]] && echo CLAWDI_VALUE= || echo CLAWDI_VALUE=777 ;;
 *"docker exec"*"stat -Lc %i /proc/self/ns/net"*) echo CLAWDI_VALUE=777 ;;
 *"docker run --rm --network container:clawdi-whatsapp-netns"*"--entrypoint stat"*) echo CLAWDI_VALUE=777 ;;
 *"docker run --rm --network container:clawdi-whatsapp-netns"*"api.ipify.org"*)
   [[ "${SCENARIO}" == preflight_fail ]] && echo CLAWDI_VALUE=198.51.100.9 || echo CLAWDI_VALUE=203.0.113.8 ;;
 *"psql"*) : ;;
esac
FAKE
chmod +x "${tmp}/bin/kamal"
printf '#!/usr/bin/env bash\nexit 0\n' > "${tmp}/bin/sleep"
chmod +x "${tmp}/bin/sleep"

run() {
	local scenario="$1" enabled="$2" log="${tmp}/$1.log"
	SCENARIO="$scenario" FAKE_LOG="$log" PATH="${tmp}/bin:$PATH" \
		SIDECAR_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		DEPLOY_IMAGE_VERSION=0123456789abcdef0123456789abcdef01234567 \
		WHATSAPP_TAILSCALE_EGRESS_ENABLED="$enabled" WHATSAPP_TAILSCALE_EXIT_NODE=exit.test \
		WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP=203.0.113.8 \
		"$root/scripts/deploy-whatsapp-sidecar.sh" >/dev/null
	echo "$log"
}

run_failure() {
	local scenario="$1" log="${tmp}/$1.log"
	if SCENARIO="$scenario" FAKE_LOG="$log" PATH="${tmp}/bin:$PATH" \
		SIDECAR_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		DEPLOY_IMAGE_VERSION=0123456789abcdef0123456789abcdef01234567 \
		WHATSAPP_TAILSCALE_EGRESS_ENABLED=true WHATSAPP_TAILSCALE_EXIT_NODE=exit.test \
		WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP=203.0.113.8 \
		"$root/scripts/deploy-whatsapp-sidecar.sh" >/dev/null 2>&1; then
		echo "expected ${scenario} to fail" >&2
		exit 1
	fi
	echo "$log"
}

transition="$(run transition true)"
infra="$(grep -n 'accessory reboot whatsapp-netns' "$transition" | cut -d: -f1)"
tailscale="$(grep -n 'accessory reboot whatsapp-tailscale' "$transition" | tail -n 1 | cut -d: -f1)"
guard="$(grep -n 'accessory reboot whatsapp-egress-guard' "$transition" | tail -n 1 | cut -d: -f1)"
preflight="$(grep -n 'api.ipify.org' "$transition" | cut -d: -f1)"
sidecar="$(grep -n 'accessory reboot whatsapp-baileys' "$transition" | tail -n 1 | cut -d: -f1)"
test "$infra" -lt "$tailscale" && test "$tailscale" -lt "$guard"
test "$guard" -lt "$preflight" && test "$preflight" -lt "$sidecar"
grep -q 'accessory stop whatsapp-baileys' "$transition"
grep -q 'iptables -C OUTPUT -m owner --uid-owner 1000' "$transition"
grep -q 'AbortSignal.timeout(15000)' "$transition"
grep -q "stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/tailscale-state'" "$transition"
grep -q "stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/egress-guard'" "$transition"
grep -q "mktemp '/home/phala/clawdi-whatsapp/.tailscale-resolv.conf.XXXXXX'" "$transition"
grep -q "stat -c '%u:%g:%a' '/home/phala/clawdi-whatsapp/tailscale-resolv.conf'" "$transition"
grep -q 'test ! -L /guard/network-namespace.ready' "$transition"

reenable="$(run reenable true)"
stop="$(grep -n 'accessory stop whatsapp-baileys' "$reenable" | head -n 1 | cut -d: -f1)"
preflight="$(grep -n 'api.ipify.org' "$reenable" | cut -d: -f1)"
reboot="$(grep -n 'accessory reboot whatsapp-baileys' "$reenable" | cut -d: -f1)"
test "$stop" -lt "$preflight" && test "$preflight" -lt "$reboot"
! grep -q 'accessory reboot whatsapp-netns' "$reenable"

failed="$(run_failure preflight_fail)"
grep -q 'accessory stop whatsapp-baileys' "$failed"
grep -q 'api.ipify.org' "$failed"
! grep -q 'accessory reboot whatsapp-baileys' "$failed"

stop_failure="$(run_failure stop_failure)"
grep -q 'accessory stop whatsapp-baileys' "$stop_failure"
! grep -q 'api.ipify.org' "$stop_failure"
stop_still_running="$(run_failure stop_still_running)"
grep -q 'accessory stop whatsapp-baileys' "$stop_still_running"
! grep -q 'api.ipify.org' "$stop_still_running"

steady="$(run steady true)"
grep -q 'api.ipify.org' "$steady"
! grep -q 'accessory reboot whatsapp-baileys' "$steady"

disable="$(run disable false)"
grep -q 'accessory reboot whatsapp-baileys' "$disable"
! grep -q 'api.ipify.org' "$disable"

stopped_enabled="$(run stopped_enabled true)"
grep -q 'accessory reboot whatsapp-baileys' "$stopped_enabled"
stopped_disabled="$(run stopped_disabled false)"
grep -q 'accessory reboot whatsapp-baileys' "$stopped_disabled"

namespace_drift="$(run namespace_drift true)"
grep -q 'accessory reboot whatsapp-tailscale' "$namespace_drift"
! grep -q '/proc/[0-9].*/ns/net' "$namespace_drift"
