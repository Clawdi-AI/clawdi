#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${TEST_RUNNER_IMAGE:?Set TEST_RUNNER_IMAGE to the repository Docker test-runner image}"
scratch="$(mktemp -d "$repo_root/.vault-upgrade.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Download/build in an isolated container before the second container maps github.com
# to its private TLS fixture. No host DNS, credentials or installation are changed.
docker run --rm --cpus=2 --memory=4g --pids-limit=256 --user 1000:1000 \
  -e BUN_INSTALL_CACHE_DIR=/tmp/bun -e BUN_TMPDIR=/tmp \
  --mount "type=bind,src=$repo_root,dst=/repo,readonly" \
  --mount "type=bind,src=$scratch,dst=/out" "$TEST_RUNNER_IMAGE" bash -c '
set -euo pipefail
mkdir -p /work/clawdi
rsync -a --no-owner --no-group --exclude .git --exclude node_modules --exclude .venv --exclude ".vault-upgrade.*" /repo/ /work/clawdi/
cd /work/clawdi
curl -fL --retry 2 --max-time 180 https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v0.14.68/clawdi-cli-linux-x64.tar.gz -o /out/old.tar.gz
curl -fL --retry 2 --max-time 30 https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v0.14.68/clawdi-cli-manifest.txt -o /out/old-manifest.txt
bun install --frozen-lockfile --ignore-scripts --silent
bun run --cwd packages/cli build:native
bun run --cwd packages/cli package:native-release
cp packages/cli/dist-release/clawdi-cli-linux-x64.tar.gz /out/candidate.tar.gz
bun build packages/cli/tests/e2e/published-native-upgrade.mjs --target bun --outdir /out
'

docker run --rm --cpus=2 --memory=2g --pids-limit=256 --user 0:0 \
  --add-host github.com:127.0.0.1 \
  --mount "type=bind,src=$scratch,dst=/artifacts,readonly" \
  --mount "type=bind,src=$repo_root,dst=/repo,readonly" \
  "$TEST_RUNNER_IMAGE" bun /artifacts/published-native-upgrade.js
