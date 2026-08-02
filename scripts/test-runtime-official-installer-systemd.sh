#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
fixture="$repo_root/packages/cli/tests/fixtures/runtime-official-installer-systemd/Dockerfile"
image="clawdi-runtime-official-installer-systemd-test:local-$$"
container="clawdi-runtime-official-installer-systemd-test-$$"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! -d "$repo_root/node_modules" ]]; then
	echo "node_modules is missing; run bun install --frozen-lockfile first" >&2
	exit 2
fi

docker build --quiet --file "$fixture" --tag "$image" "$(dirname -- "$fixture")" >/dev/null
docker run --detach --privileged \
	--name "$container" \
	--tmpfs /run \
	--tmpfs /run/lock \
	--tmpfs /tmp:exec \
	--volume "$repo_root:/repo" \
	--workdir /repo \
	"$image" >/dev/null

for _attempt in $(seq 1 100); do
	if docker exec "$container" systemctl is-system-running >/dev/null 2>&1; then
		break
	fi
	if docker exec "$container" systemctl is-system-running 2>/dev/null | grep -Eq '^(running|degraded)$'; then
		break
	fi
	sleep 0.1
done

docker exec "$container" loginctl enable-linger clawdi
docker exec "$container" systemctl start user@10001.service
for _attempt in $(seq 1 100); do
	if docker exec "$container" test -S /run/user/10001/bus \
		&& docker exec "$container" systemctl is-active --quiet user@10001.service; then
		break
	fi
	sleep 0.1
done
docker exec "$container" test -S /run/user/10001/bus
docker exec "$container" systemctl is-active --quiet user@10001.service
docker exec --env CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD=1 "$container" \
	bun test --isolate --max-concurrency=1 --timeout 30000 \
	packages/cli/tests/e2e/runtime-official-installer-systemd.e2e.test.ts
