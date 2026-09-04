#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp}"' EXIT
mkdir -p "${tmp}/bin"

cat > "${tmp}/bin/kamal" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${FAKE_LOG}"
case "$*" in
	"deploy -P --roles web "*) touch "${FAKE_LOG}.web.deployed"; exit 0 ;;
	"deploy -P --roles channels-worker "*) touch "${FAKE_LOG}.channels-worker.deployed"; exit 0 ;;
	"app exec "*|"app stop "*) exit 0 ;;
	"accessory exec postgres "*) echo "CLAWDI_VALUE=${AVAILABLE_CONNECTIONS:-80}"; exit 0 ;;
	*"docker ps -q"*"role=web"*) role=web ;;
	*"docker ps -q"*"role=channels-worker"*) role=channels-worker ;;
	*) exit 0 ;;
esac

pool="${WEB_POOL}"
[[ "${role}" == channels-worker ]] && pool="${CHANNELS_POOL}"
if [[ "${pool}" == missing ]]; then
	echo "CLAWDI_VALUE=missing"
	exit 0
fi
image="ghcr.io/clawdi-ai/clawdi-backend:${CURRENT_IMAGE}"
if [[ -f "${FAKE_LOG}.${role}.deployed" ]]; then
	pool=10:10:5
	image="ghcr.io/clawdi-ai/clawdi-backend:${DEPLOY_IMAGE_VERSION}"
fi
echo "CLAWDI_VALUE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|${image}|${pool}"
FAKE
chmod +x "${tmp}/bin/kamal"

readonly target_image=0123456789abcdef0123456789abcdef01234567
readonly current_image=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run() {
	local scenario="$1" web_pool="$2" channels_pool="$3" available="${4:-80}"
	local log="${tmp}/${scenario}.log"
	if ! FAKE_LOG="${log}" PATH="${tmp}/bin:${PATH}" \
		DEPLOY_IMAGE_VERSION="${target_image}" CURRENT_IMAGE="${current_image}" \
		WEB_POOL="${web_pool}" CHANNELS_POOL="${channels_pool}" \
		AVAILABLE_CONNECTIONS="${available}" \
		"${root}/scripts/deploy-backend.sh" >/dev/null; then
		return 1
	fi
	printf '%s\n' "${log}"
}

legacy="$(run legacy 20:20:45 20:20:45)"
grep -q '^app stop --roles channels-worker$' "${legacy}"
migration_line="$(grep -n 'app exec --primary --roles web --raw' "${legacy}" | cut -d: -f1)"
channels_line="$(grep -n 'deploy -P --roles channels-worker' "${legacy}" | cut -d: -f1)"
web_line="$(grep -n 'deploy -P --roles web' "${legacy}" | cut -d: -f1)"
test "${migration_line}" -lt "${channels_line}" && test "${channels_line}" -lt "${web_line}"

bounded="$(run bounded 10:10:5 10:10:5)"
! grep -q 'app stop' "${bounded}"
grep -q 'deploy -P --roles channels-worker' "${bounded}"
grep -q 'deploy -P --roles web' "${bounded}"

resumed="$(run resumed 20:20:45 10:10:5)"
! grep -q 'app stop' "${resumed}"
grep -q 'deploy -P --roles channels-worker' "${resumed}"

if run invalid 12:12:5 10:10:5 >/dev/null 2>&1; then
	echo "Expected an unknown pool configuration to fail" >&2
	exit 1
fi

if run saturated 20:20:45 20:20:45 19 >/dev/null 2>&1; then
	echo "Expected insufficient PostgreSQL headroom to fail" >&2
	exit 1
fi
