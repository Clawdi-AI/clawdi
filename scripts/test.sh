#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

suite="${1:-all}"
if [[ $# -gt 0 ]]; then
	shift
fi

case "$suite" in
	all|backend|js|cli|web)
		;;
	*)
		echo "Unknown test suite: $suite" >&2
		echo "Usage: scripts/test.sh [all|js|cli|web|backend] [suite args...]" >&2
		exit 2
		;;
esac

compose_project_name="${CLAWDI_TEST_COMPOSE_PROJECT_NAME:-clawdi-test-$$}"
remove_test_runner_image=false
if [[ -z "${TEST_RUNNER_IMAGE:-}" ]]; then
	export TEST_RUNNER_IMAGE="clawdi-test-runner:${compose_project_name}"
	remove_test_runner_image=true
fi
compose=(docker compose -p "$compose_project_name" -f docker-compose.test.yml)
cleanup() {
	"${compose[@]}" down --remove-orphans --volumes >/dev/null
	if [[ "$remove_test_runner_image" == true ]]; then
		docker image rm "$TEST_RUNNER_IMAGE" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

if [[ "${CLAWDI_TEST_RUNNER_SKIP_BUILD:-0}" != "1" ]]; then
	"${compose[@]}" build test-runner
fi

case "$suite" in
	all|backend)
		"${compose[@]}" run --rm test-runner "$suite" "$@"
		;;
	js|cli|web)
		"${compose[@]}" run --rm --no-deps test-runner "$suite" "$@"
		;;
esac
