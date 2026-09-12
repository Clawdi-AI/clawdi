#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$repo_root/packages/cli/tests/fixtures/runtime-official-installer-systemd/Dockerfile"
image="clawdi-systemd-command-test:local-$$"
container="clawdi-systemd-command-test-$$"
cleanup() {
	docker rm --force "$container" >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reuse only the systemd stage; no agent packages, models or runtime installs.
docker build --quiet --target systemd --file "$fixture" --tag "$image" \
	"$(dirname -- "$fixture")" >/dev/null
docker run --detach --privileged --cgroupns=private \
	--cpus=2 --memory=2g --pids-limit=256 --name "$container" \
	--tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec \
	--volume "$repo_root:/repo:ro" --workdir /work "$image" >/dev/null
docker exec "$container" timeout 20 bash -c '
	until systemctl show --property=Version >/dev/null 2>&1; do sleep 0.1; done
'
docker exec "$container" bash -euo pipefail -c '
	mkdir -p /work
	tar -C /repo --exclude=.git --exclude=node_modules --exclude=.venv \
		--exclude=.env --exclude=.env.local -cf - . | tar -C /work -xf -
	cd /work
	bun install --frozen-lockfile --ignore-scripts
	CLAWDI_TEST_SYSTEMD_COMMAND=1 timeout 60 bun test --isolate --max-concurrency=1 \
		--timeout=15000 packages/cli/src/runtime/systemd.test.ts
'
