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
	"deploy -P --roles embedding-worker "*) touch "${FAKE_LOG}.embedding-worker.deployed"; exit 0 ;;
	"app exec --primary --roles embedding-worker --reuse --raw "*"python -m app.workers.embedding healthcheck")
		[[ "${FAIL_EMBEDDING_HEALTH:-0}" != 1 ]]
		exit
		;;
	"app exec --primary --roles web --reuse --raw "*"curl "*"/ready")
		[[ "${FAIL_WEB_READY:-0}" != 1 ]]
		exit
		;;
	"app exec "*|"app stop "*) exit 0 ;;
	"accessory exec postgres "*) echo "CLAWDI_VALUE=${AVAILABLE_CONNECTIONS:-80}"; exit 0 ;;
	*"docker ps -q"*"role=web"*) role=web ;;
	*"docker ps -q"*"role=channels-worker"*) role=channels-worker ;;
	*"docker ps -q"*"role=embedding-worker"*) role=embedding-worker ;;
	*) exit 0 ;;
esac

if [[ "${role}" == embedding-worker ]]; then
	if [[ "${EMBEDDING_STATE:-missing}" == missing && ! -f "${FAKE_LOG}.embedding-worker.deployed" ]]; then
		echo "CLAWDI_VALUE=missing"
		exit 0
	fi
	pool="${EMBEDDING_POOL:-::}"
	workers=""
else
	pool="${WEB_POOL}"
	workers="${WEB_WORKERS:-}"
	if [[ "${role}" == channels-worker ]]; then
		pool="${CHANNELS_POOL}"
		workers=""
	fi
fi

image="ghcr.io/clawdi-ai/clawdi-backend:${CURRENT_IMAGE}"
if [[ -f "${FAKE_LOG}.${role}.deployed" ]]; then
	image="ghcr.io/clawdi-ai/clawdi-backend:${DEPLOY_IMAGE_VERSION}"
	case "${role}" in
		web) pool=5:5:5; workers=2 ;;
		channels-worker) pool=10:10:5 ;;
		embedding-worker) pool=:: ;;
	esac
fi
echo "CLAWDI_VALUE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|${image}|${pool}|${workers}"
FAKE
chmod +x "${tmp}/bin/kamal"

readonly target_image=0123456789abcdef0123456789abcdef01234567
readonly current_image=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

run() {
	local scenario="$1" web_pool="$2" channels_pool="$3" available="${4:-80}"
	local embedding_state="${5:-missing}" fail_embedding_health="${6:-0}"
	local fail_web_ready="${7:-0}" web_workers="${8:-}"
	local log="${tmp}/${scenario}.log"
	if ! FAKE_LOG="${log}" PATH="${tmp}/bin:${PATH}" \
		DEPLOY_IMAGE_VERSION="${target_image}" CURRENT_IMAGE="${current_image}" \
		WEB_POOL="${web_pool}" CHANNELS_POOL="${channels_pool}" \
		AVAILABLE_CONNECTIONS="${available}" EMBEDDING_STATE="${embedding_state}" \
		FAIL_EMBEDDING_HEALTH="${fail_embedding_health}" FAIL_WEB_READY="${fail_web_ready}" \
		WEB_WORKERS="${web_workers}" \
		"${root}/scripts/deploy-backend.sh" >/dev/null; then
		return 1
	fi
	printf '%s\n' "${log}"
}

legacy="$(run legacy 20:20:45 20:20:45)"
grep -q '^app stop --roles channels-worker$' "${legacy}"
migration_line="$(grep -n 'alembic upgrade head' "${legacy}" | cut -d: -f1)"
embedding_line="$(grep -n 'deploy -P --roles embedding-worker' "${legacy}" | cut -d: -f1)"
embedding_health_line="$(grep -n 'python -m app.workers.embedding healthcheck' "${legacy}" | cut -d: -f1)"
channels_line="$(grep -n 'deploy -P --roles channels-worker' "${legacy}" | cut -d: -f1)"
web_line="$(grep -n 'deploy -P --roles web' "${legacy}" | cut -d: -f1)"
ready_line="$(grep -n 'curl .*\/ready' "${legacy}" | cut -d: -f1)"
test "${migration_line}" -lt "${embedding_line}"
test "${embedding_line}" -lt "${embedding_health_line}"
test "${embedding_health_line}" -lt "${channels_line}"
test "${channels_line}" -lt "${web_line}"
test "${web_line}" -lt "${ready_line}"

bounded="$(run bounded 10:10:5 10:10:5)"
! grep -q 'app stop' "${bounded}"
grep -q 'deploy -P --roles embedding-worker' "${bounded}"
grep -q 'deploy -P --roles channels-worker' "${bounded}"
grep -q 'deploy -P --roles web' "${bounded}"

resumed="$(run resumed 5:5:5 10:10:5 80 present 0 0 2)"
! grep -q 'app stop' "${resumed}"
grep -q 'python -m app.workers.embedding healthcheck' "${resumed}"

if run invalid 12:12:5 10:10:5 >/dev/null 2>&1; then
	echo "Expected an unknown pool configuration to fail" >&2
	exit 1
fi

if run saturated 10:10:5 10:10:5 19 >/dev/null 2>&1; then
	echo "Expected insufficient PostgreSQL headroom to fail" >&2
	exit 1
fi

if run embedding-health-failure 10:10:5 10:10:5 80 missing 1 >/dev/null 2>&1; then
	echo "Expected failed embedding identity health to stop deployment" >&2
	exit 1
fi
! grep -q 'deploy -P --roles channels-worker' "${tmp}/embedding-health-failure.log"
! grep -q 'deploy -P --roles web' "${tmp}/embedding-health-failure.log"

if run web-readiness-failure 10:10:5 10:10:5 80 missing 0 1 >/dev/null 2>&1; then
	echo "Expected failed web readiness to fail deployment" >&2
	exit 1
fi
