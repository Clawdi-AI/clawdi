#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly FIXTURE_ROOT="${REPO_ROOT}/packages/cli/tests/fixtures/managed-whatsapp-native-e2e"
readonly IMAGE="clawdi-managed-whatsapp-native-e2e:local"

docker build \
	--file "${FIXTURE_ROOT}/Dockerfile" \
	--tag "${IMAGE}" \
	"${REPO_ROOT}"

for runtime in openclaw hermes; do
	docker run --rm \
		--network none \
		--cap-add NET_ADMIN \
		--add-host web.whatsapp.com:127.0.0.1 \
		--tmpfs /tmp:rw,exec,size=1073741824 \
		--env "E2E_RUNTIME=${runtime}" \
		"${IMAGE}"
done
