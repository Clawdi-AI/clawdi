#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$repo_root/packages/cli/tests/fixtures/runtime-official-installer-systemd/Dockerfile"
image="clawdi-systemd-command-test:local-$$"
container="clawdi-systemd-command-test-$$"
cleanup() {
	timeout --kill-after=5s 30s docker rm --force "$container" >/dev/null 2>&1 || true
	timeout --kill-after=5s 30s docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reuse only the systemd stage; no agent packages, models or runtime installs.
# This stage needs no checkout build context.
timeout --kill-after=15s 900s docker build --quiet --target systemd --tag "$image" - < "$fixture" >/dev/null
timeout --kill-after=15s 30s docker run --detach --privileged --cgroupns=private \
	--cpus=2 --memory=2g --pids-limit=256 --name "$container" \
	--tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec \
	--workdir /work "$image" >/dev/null
timeout --kill-after=15s 30s docker exec "$container" timeout 20 bash -c '
	until systemctl show --property=Version >/dev/null 2>&1; do sleep 0.1; done
'
# Never mount the unfiltered checkout in the privileged fixture. Native command
# checks need no environment examples, so exclude all .env variants as well.
timeout --kill-after=15s 120s tar -C "$repo_root" \
	--exclude=.git --exclude=.paseo --exclude=.kamal \
	--exclude=.ssh --exclude=.aws --exclude=.kube --exclude=.gnupg \
	--exclude=.npmrc --exclude=.netrc --exclude=.clawdi.env \
	--exclude=.env --exclude='.env.*' --exclude='.envrc*' \
	--exclude=node_modules --exclude=.venv --exclude=__pycache__ --exclude='*.pyc' \
	--exclude=.pytest_cache --exclude=.ruff_cache --exclude=.turbo \
	--exclude=.output --exclude=.nitro --exclude=.tanstack --exclude='.vite*' \
	--exclude=test-results --exclude=playwright-report --exclude=coverage \
	--exclude=dist --exclude=dist-native --exclude=dist-release \
	--exclude='./backend/data' --exclude=tmp --exclude='*.log' --exclude='*.tsbuildinfo' \
	--exclude='.component-tools.*' --exclude='.provider-recovery-baseline.*' \
	-cf - . | timeout --kill-after=15s 120s docker exec --interactive "$container" tar -C /work -xf -
timeout --kill-after=15s 930s docker exec "$container" timeout 900 bash -euo pipefail -c '
	cd /work
	bun install --frozen-lockfile --ignore-scripts
	CLAWDI_TEST_SYSTEMD_COMMAND=1 timeout 60 bun test --isolate --max-concurrency=1 \
		--timeout=15000 packages/cli/src/runtime/systemd.test.ts
'
