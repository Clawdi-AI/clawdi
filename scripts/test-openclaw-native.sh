#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_name="clawdi-openclaw-native-$$"
cleanup() {
  docker rm -f "$test_name" >/dev/null 2>&1 || true
  docker image rm "$test_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -t "$test_name" - <<'DOCKERFILE'
FROM oven/bun:1.4.0 AS bun
FROM mcr.microsoft.com/playwright:v1.62.1-noble
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
DOCKERFILE
docker run --rm --name "$test_name" --cpus 4 --memory 4g --memory-swap 4g \
  --pids-limit 512 -v "$repo_root:/repo:ro" -e HOME=/tmp/openclaw-home \
  -e CI=true "$test_name" timeout 900 bash -euo pipefail -c '
mkdir -p /work/clawdi "$HOME"
tar -C /repo --exclude=.git --exclude=node_modules --exclude=.env --exclude=".env.*" \
  --exclude=.envrc --exclude=.paseo --exclude=test-results --exclude=.output \
  --exclude=.tanstack --exclude=.venv -cf - . | tar -C /work/clawdi -xf -
cd /work
npm install --ignore-scripts --no-audit --no-fund openclaw@2026.9.4
node -e '\''const b=require("./node_modules/openclaw/dist/build-info.json"); if(b.commit!=="3a9d69db306cd7f081e06254cb89c4bcc14a7107") throw Error("Unexpected official OpenClaw source");'\''
export OPENCLAW_TEST_ENTRY=/work/node_modules/openclaw/openclaw.mjs
cd /work/clawdi
bun install --frozen-lockfile --ignore-scripts
node apps/web/e2e/openclaw-native/gateway.mjs > /work/gateway-fixture.log 2>&1 &
fixture_pid=$!
trap '\''kill "$fixture_pid" 2>/dev/null || true'\'' EXIT
for attempt in $(seq 1 60); do
  if curl -kfsS https://127.0.0.1:19443/readyz >/dev/null 2>&1; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat /work/gateway-fixture.log; exit 1; fi
  sleep 1
done
curl -kfsS https://127.0.0.1:19443/readyz >/dev/null || { cat /work/gateway-fixture.log; exit 1; }
bun run --cwd apps/web e2e --config=playwright.openclaw.config.ts
'
