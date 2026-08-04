#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
run_pids=()
run_cidfiles=()
cleanup() {
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
	if [[ "${remove_artifact_root}" == true && -n "${artifact_root}" ]]; then
		rm -rf "${artifact_root}"
	fi
}
trap cleanup EXIT INT TERM

if [[ "${MODE}" != "--run-only" ]]; then
	if [[ -z "${artifact_root}" ]]; then
		artifact_root="$(mktemp -d)"
		remove_artifact_root=true
	fi
	"${FIXTURE_ROOT}/fetch-upstream-artifacts.sh" "${artifact_root}"
fi

if [[ "${MODE}" == "--fetch-only" ]]; then
	exit 0
fi

if [[ "${MODE}" != "--run-only" ]]; then
	for runtime in "${RUNTIMES[@]}"; do
		docker buildx build \
			--file "${FIXTURE_ROOT}/Dockerfile" \
			--target "${runtime}" \
			--tag "${IMAGE_PREFIX}:${runtime}-local" \
			--build-context "e2e_artifacts=${artifact_root}" \
			--load \
			"${REPO_ROOT}"
	done
fi

if [[ "${MODE}" == "--build-only" ]]; then
	exit 0
fi

run_log_root="$(mktemp -d)"
for runtime in "${RUNTIMES[@]}"; do
	cidfile="${run_log_root}/${runtime}.cid"
	docker run --rm \
		--cidfile "${cidfile}" \
		--network none \
		--cap-add NET_ADMIN \
		--add-host web.whatsapp.com:127.0.0.1 \
		--tmpfs /tmp:rw,exec,size=1073741824 \
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
exit "${status}"
