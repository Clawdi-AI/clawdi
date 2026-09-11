#!/usr/bin/env bash
# Runs inside the isolated build container; /repo is read-only and /out is caller-owned.
set -euo pipefail
build_root="$(mktemp -d /tmp/clawdi-native-build.XXXXXX)"
rsync -a --no-owner --no-group --exclude .git --exclude node_modules --exclude .venv --exclude ".vault-upgrade.*" /repo/ "$build_root/"
cd "$build_root"
curl -fL --retry 2 --max-time 180 https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v0.14.68/clawdi-cli-linux-x64.tar.gz -o /out/old.tar.gz
curl -fL --retry 2 --max-time 30 https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v0.14.68/clawdi-cli-manifest.txt -o /out/old-manifest.txt
bun install --frozen-lockfile --ignore-scripts --silent
bun run --cwd packages/cli build:native
bun run --cwd packages/cli package:native-release
cp packages/cli/dist-release/clawdi-cli-linux-x64.tar.gz /out/candidate.tar.gz
bun build packages/cli/tests/e2e/published-native-upgrade.mjs --target bun --outdir /out
