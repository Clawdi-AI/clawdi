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
 *egress-healthcheck.js*)
   if [[ "${SCENARIO}" == transition ]]; then
     count_file="${FAKE_LOG}.egress-attempts"
     count=0; [[ ! -f "${count_file}" ]] || count="$(<"${count_file}")"
     count=$((count + 1)); echo "${count}" > "${count_file}"
     [[ "${count}" -ge 3 ]]
   fi
   ;;
 *whatsapp-sidecar.deployment-revision*) echo "CLAWDI_INSPECT=${SIDECAR_REVISION}";;
 *whatsapp-egress.config-revision*) echo "CLAWDI_INSPECT=${WHATSAPP_TAILSCALE_CONFIG_REVISION}";;
 *HostConfig.NetworkMode*) [[ "${SCENARIO}" == disable ]] && echo CLAWDI_INSPECT=kamal || echo CLAWDI_INSPECT=kamal;;
 *State.Running*) echo CLAWDI_INSPECT=true;;
 *Config.Env*)
   if [[ "${SCENARIO}" == steady || "${SCENARIO}" == disable ]]; then
     echo 'CLAWDI_INSPECT=["CLAWDI_WA_SIDECAR_PROXY_URL=http://clawdi-whatsapp-tailscale:8080"]'
   else
     echo 'CLAWDI_INSPECT=[]'
   fi
   ;;
 *psql*) :;;
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
 WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP=203.0.113.8 "$root/scripts/deploy-whatsapp-sidecar.sh" >/dev/null
 echo "$log"
}
transition="$(run transition true)"
probe="$(grep -n egress-healthcheck.js "$transition" | head -n 1 | cut -d: -f1)"
reboot="$(grep -n 'accessory reboot whatsapp-baileys' "$transition" | cut -d: -f1)"
test "$probe" -lt "$reboot"
test "$(grep -c egress-healthcheck.js "$transition")" -eq 3
! grep -q 'accessory stop whatsapp-baileys' "$transition"
steady="$(run steady true)"
grep -q egress-healthcheck.js "$steady"
! grep -q 'accessory reboot whatsapp-baileys' "$steady"
disable="$(run disable false)"
grep -q 'accessory reboot whatsapp-baileys' "$disable"
! grep -q egress-healthcheck.js "$disable"
