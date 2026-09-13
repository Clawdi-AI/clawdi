#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly FIXTURE_ROOT="${REPO_ROOT}/packages/cli/tests/fixtures/managed-whatsapp-native-e2e"
readonly IMAGE_PREFIX="${E2E_IMAGE_PREFIX:-clawdi-managed-whatsapp-native-e2e}"
readonly MODE="${1:---all}"
readonly -a RUNTIMES=(openclaw hermes)

case "${MODE}" in
	--all | --fetch-only | --build-only | --run-only) ;;
	*)
		echo "usage: $0 [--all|--fetch-only|--build-only|--run-only]" >&2
		exit 2
		;;
esac

artifact_root="${E2E_ARTIFACT_DIR:-}"
remove_artifact_root=false
run_log_root=""
capture_root=""
run_pids=()
run_cidfiles=()
cleanup() {
	local status="$1"
	trap - EXIT INT TERM
	set +e
	for pid in "${run_pids[@]}"; do
		kill "${pid}" 2>/dev/null || true
	done
	for cidfile in "${run_cidfiles[@]}"; do
		if [[ -s "${cidfile}" ]]; then
			container_id=""
			IFS= read -r container_id <"${cidfile}" || true
			docker rm --force "${container_id}" >/dev/null 2>&1 || true
		fi
	done
	if [[ -n "${run_log_root}" ]]; then
		rm -rf "${run_log_root}"
	fi
	if [[ -n "${capture_root}" ]]; then
		rm -rf "${capture_root}"
	fi
	if [[ "${remove_artifact_root}" == true && -n "${artifact_root}" ]]; then
		rm -rf "${artifact_root}"
	fi
	return "${status}"
}
trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${MODE}" != "--run-only" ]]; then
	if [[ -z "${artifact_root}" ]]; then
		artifact_root="$(mktemp -d)"
		remove_artifact_root=true
	fi
	"${FIXTURE_ROOT}/fetch-upstream-artifacts.sh" "${artifact_root}"
fi

if [[ "${MODE}" == "--fetch-only" ]]; then
	cleanup 0
	exit 0
fi

if [[ "${MODE}" != "--run-only" ]]; then
	(
		cd "${REPO_ROOT}"
		E2E_ARTIFACT_DIR="${artifact_root}" E2E_IMAGE_PREFIX="${IMAGE_PREFIX}" \
			docker buildx bake --file "${FIXTURE_ROOT}/docker-bake.hcl" --load
	)
fi

if [[ "${MODE}" == "--build-only" ]]; then
	cleanup 0
	exit 0
fi

run_log_root="$(mktemp -d)"
capture_root="$(mktemp -d "${REPO_ROOT}/.wa-native-captures.XXXXXX")"
# Only synthetic message envelopes are exported here. The clean runner's UID
# may differ from the CI user that created this directory.
chmod 0755 "${capture_root}"
for runtime in "${RUNTIMES[@]}"; do
	cidfile="${run_log_root}/${runtime}.cid"
	docker run --rm \
		--cidfile "${cidfile}" \
		--network none \
		--cpus 2 --memory 3g --memory-swap 3g --pids-limit 1024 \
		--cap-add NET_ADMIN \
		--add-host web.whatsapp.com:127.0.0.1 \
		--tmpfs /tmp:rw,exec,size=1073741824 \
		--volume "${capture_root}:/native-captures" \
		--env "E2E_RUNTIME=${runtime}" \
		"${IMAGE_PREFIX}:${runtime}-local" \
		>"${run_log_root}/${runtime}.log" 2>&1 &
	run_pids+=("$!")
	run_cidfiles+=("${cidfile}")
done

status=0
for index in "${!RUNTIMES[@]}"; do
	runtime="${RUNTIMES[${index}]}"
	if ! wait "${run_pids[${index}]}"; then
		status=1
	fi
	cat "${run_log_root}/${runtime}.log"
done
run_pids=()
if [[ "${status}" == 0 ]]; then
	if ! "${REPO_ROOT}/scripts/test.sh" backend tests/whatsapp_native_outbound_e2e.py \
		--whatsapp-native-captures "../${capture_root#"${REPO_ROOT}/"}"; then
		status=1
	fi
fi
cleanup "${status}"
exit "${status}"
