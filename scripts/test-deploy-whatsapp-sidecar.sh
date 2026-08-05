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
 *"whatsapp-sidecar.deployment-revision"*)
   [[ "${SCENARIO}" == transition ]] && echo CLAWDI_VALUE=old || echo "CLAWDI_VALUE=${SIDECAR_REVISION}" ;;
 *"whatsapp-netns.config-revision"*)
   [[ "${SCENARIO}" == transition ]] && echo CLAWDI_VALUE=old || echo "CLAWDI_VALUE=${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ;;
 *"whatsapp-egress.config-revision"*) echo "CLAWDI_VALUE=${WHATSAPP_TAILSCALE_CONFIG_REVISION}" ;;
 *"HostConfig.NetworkMode"*)
   [[ "${SCENARIO}" == disable ]] && echo CLAWDI_VALUE=container:clawdi-whatsapp-netns || echo CLAWDI_VALUE=container:clawdi-whatsapp-netns ;;
 *"State.Running"*) echo CLAWDI_VALUE=true ;;
 *"State.Pid"*) echo CLAWDI_VALUE=4242 ;;
 *"stat -Lc %i /proc/4242/ns/net"*) echo CLAWDI_VALUE=777 ;;
 *"docker run --rm --network container:clawdi-whatsapp-netns"*) echo CLAWDI_VALUE=203.0.113.8 ;;
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

transition="$(run transition true)"
infra="$(grep -n 'accessory reboot whatsapp-netns' "$transition" | cut -d: -f1)"
tailscale="$(grep -n 'accessory reboot whatsapp-tailscale' "$transition" | tail -n 1 | cut -d: -f1)"
guard="$(grep -n 'accessory reboot whatsapp-egress-guard' "$transition" | tail -n 1 | cut -d: -f1)"
preflight="$(grep -n 'docker run --rm --network container:clawdi-whatsapp-netns' "$transition" | cut -d: -f1)"
sidecar="$(grep -n 'accessory reboot whatsapp-baileys' "$transition" | tail -n 1 | cut -d: -f1)"
test "$infra" -lt "$tailscale" && test "$tailscale" -lt "$guard"
test "$guard" -lt "$preflight" && test "$preflight" -lt "$sidecar"
grep -q 'accessory stop whatsapp-baileys' "$transition"
grep -q 'iptables -C OUTPUT -m owner --uid-owner 1000' "$transition"

steady="$(run steady true)"
grep -q 'docker run --rm --network container:clawdi-whatsapp-netns' "$steady"
! grep -q 'accessory reboot whatsapp-baileys' "$steady"

disable="$(run disable false)"
grep -q 'accessory reboot whatsapp-baileys' "$disable"
! grep -q 'docker run --rm --network container:clawdi-whatsapp-netns' "$disable"
