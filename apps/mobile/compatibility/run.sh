#!/usr/bin/env bash
set -euo pipefail

profile="${1:-latest}"
case "$profile" in
	latest|supported-diagnostic|verify-source) ;;
	*) printf 'Usage: bash apps/mobile/compatibility/run.sh [latest|supported-diagnostic|verify-source]\n' >&2; exit 64 ;;
esac

probe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
artifact_dir="$probe_dir/.artifacts/$profile"
mkdir -p "$artifact_dir"
image="clawdi-mobile-v0-${UID}-$$"
container="clawdi-mobile-v0-${UID}-$$"
cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

timeout --signal=TERM --kill-after=15s 3m docker build --pull=false --tag "$image" "$probe_dir"
timeout --signal=TERM --kill-after=30s 25m docker run --rm \
	--name "$container" \
	--cpus=2 --memory=4g --memory-swap=4g --pids-limit=256 \
	--cap-drop=ALL --security-opt=no-new-privileges \
	--env "PROBE_PROFILE=$profile" \
	--mount "type=bind,source=$probe_dir,target=/probe,readonly" \
	--mount "type=bind,source=$artifact_dir,target=/output" \
	--mount "type=bind,source=$probe_dir/../../../biome.json,target=/repo-biome.json,readonly" \
	"$image"
