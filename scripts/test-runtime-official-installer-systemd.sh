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

build_args=()
for name in OPENCLAW_VERSION OPENCLAW_COMMIT OPENCLAW_INTEGRITY; do
	value_name="CLAWDI_TEST_${name}"
	if [[ -n "${!value_name:-}" ]]; then
		build_args+=(--build-arg "${name}=${!value_name}")
	fi
done

docker build --quiet "${build_args[@]}" --file "$fixture" --tag "$image" \
	"$(dirname -- "$fixture")" >/dev/null
docker run --detach --privileged \
	--name "$container" \
	--tmpfs /run \
	--tmpfs /run/lock \
	--tmpfs /tmp:exec \
	--tmpfs /work:exec \
	--volume "$repo_root:/repo:ro" \
	--workdir /work \
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

docker exec "$container" bash -lc \
	'cp -a /repo/. /work/ \
		&& bun install --frozen-lockfile \
		&& bun run --cwd packages/cli build \
		&& mkdir -p /usr/local/share/clawdi/bootstrap \
		&& npm pack ./packages/cli --pack-destination /usr/local/share/clawdi/bootstrap --silent >/dev/null \
		&& mv /usr/local/share/clawdi/bootstrap/clawdi-*.tgz \
			/usr/local/share/clawdi/bootstrap/clawdi-local.tgz'
docker exec --env CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD=1 "$container" \
	bun test --isolate --max-concurrency=1 --timeout 30000 \
	"$@" \
	packages/cli/tests/e2e/runtime-official-installer-systemd.e2e.test.ts
