#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "${1:-}" == --in-container ]]; then
  mkdir -p /work/repo "$HOME"
  rsync -a --no-owner --no-group --exclude=.git --exclude=node_modules \
    --exclude='.task-*' --exclude=dist --exclude=release --exclude=resources/native \
    --exclude=.env --exclude='.env.*' /repo/ /work/repo/
  cd /work/repo
  bun install --frozen-lockfile --ignore-scripts --network-concurrency=16
  # Explicitly prepare Electron after disabling dependency lifecycle scripts.
  node apps/desktop/node_modules/electron/install.js
  bun run --cwd apps/desktop build
  xvfb-run -a bun apps/desktop/scripts/shared-login-e2e.ts
  exit
fi
image="clawdi-desktop-shared-login:task-$$"
container="clawdi-desktop-shared-login-$$"
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
timeout --kill-after=10s 8m docker build --tag "$image" \
  --file "$repo_root/apps/desktop/scripts/update-e2e.Dockerfile" "$repo_root"
timeout --kill-after=10s 8m docker run --rm --name "$container" \
  --cpus=2 --memory=4g --memory-swap=4g --pids-limit=512 \
  --volume "$repo_root:/repo:ro" "$image" \
  bash /repo/apps/desktop/scripts/shared-login-e2e.sh --in-container
