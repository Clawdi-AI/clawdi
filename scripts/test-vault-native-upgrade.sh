#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${TEST_RUNNER_IMAGE:?Set TEST_RUNNER_IMAGE to the repository Docker test-runner image}"
scratch="$(mktemp -d "$repo_root/.vault-upgrade.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Download/build in an isolated container before the second container maps github.com
# to its private TLS fixture. No host DNS, credentials or installation are changed.
docker run --rm --cpus=2 --memory=4g --pids-limit=256 --user "$(id -u):$(id -g)" \
  -e BUN_INSTALL_CACHE_DIR=/tmp/bun -e BUN_TMPDIR=/tmp \
  --mount "type=bind,src=$repo_root,dst=/repo,readonly" \
  --mount "type=bind,src=$scratch,dst=/out" "$TEST_RUNNER_IMAGE" bash /repo/packages/cli/tests/e2e/prepare-published-native-upgrade.sh

docker run --rm --cpus=2 --memory=2g --pids-limit=256 --user 0:0 \
  --add-host github.com:127.0.0.1 \
  --mount "type=bind,src=$scratch,dst=/artifacts,readonly" \
  --mount "type=bind,src=$repo_root,dst=/repo,readonly" \
  "$TEST_RUNNER_IMAGE" bun /artifacts/published-native-upgrade.js
