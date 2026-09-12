#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_name="clawdi-openclaw-native-$$"
paired_args=()
if [[ -n "${CLAWDI_OPENCLAW_HOSTED_SOURCE:-}" ]]; then
  test -f "$CLAWDI_OPENCLAW_HOSTED_SOURCE/backend/tests/support/openclaw_browser_native.py"
  paired_args=(-v "$CLAWDI_OPENCLAW_HOSTED_SOURCE:/hosted:ro" -e OPENCLAW_PAIRED=1)
fi
cleanup() {
  docker rm -f "$test_name" >/dev/null 2>&1 || true
  docker image rm "$test_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -t "$test_name" - <<'DOCKERFILE'
FROM oven/bun:1.4.0 AS bun
FROM ghcr.io/astral-sh/uv:0.12.5 AS uv
FROM mcr.microsoft.com/playwright:v1.62.1-noble
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /usr/local/bin/uv
DOCKERFILE
docker run --rm --name "$test_name" --cpus 4 --memory 4g --memory-swap 4g \
  --pids-limit 512 -v "$repo_root:/repo:ro" -e HOME=/tmp/openclaw-home \
  "${paired_args[@]}" \
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
if [[ "${OPENCLAW_PAIRED:-}" = 1 ]]; then
  mkdir -p /work/hosted
  tar -C /hosted --exclude=.git --exclude=node_modules --exclude=.env --exclude=".env.*" --exclude=.venv -cf - backend infra config | tar -C /work/hosted -xf -
  uv sync --project /work/hosted/backend --frozen --python python3
  # A real non-loopback client address is required by official proxy attribution.
  fixture_ip="$(hostname -i)"
  printf "%s cloud.clawdi.test api.clawdi.test cloud-api.clawdi.test agent-42-18789.prod.clawdi.test\n" "$fixture_ip" >> /etc/hosts
  cd /work
  curl -fsSLO https://github.com/traefik/traefik/releases/download/v3.7.12/traefik_v3.7.12_linux_amd64.tar.gz
  curl -fsSLO https://github.com/traefik/traefik/releases/download/v3.7.12/traefik_v3.7.12_checksums.txt
  sha256sum --ignore-missing -c traefik_v3.7.12_checksums.txt
  tar -xzf traefik_v3.7.12_linux_amd64.tar.gz traefik
  cd /work/hosted/backend
  uv run --frozen python -c "from app.core.test_env import apply_backend_test_environment; apply_backend_test_environment(); import uvicorn; uvicorn.run(\"tests.support.openclaw_browser_native:app\", host=\"127.0.0.1\", port=19445)" > /work/browser-issuer.log 2>&1 &
  issuer_pid=$!
  trap '\''kill "$fixture_pid" "$issuer_pid" "${proxy_pid:-}" 2>/dev/null || true'\'' EXIT
  for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:19445/fixture >/dev/null 2>&1; then break; fi
    if ! kill -0 "$issuer_pid" 2>/dev/null; then cat /work/browser-issuer.log; exit 1; fi
    sleep 1
  done
  curl -fsS http://127.0.0.1:19445/fixture >/dev/null || { cat /work/browser-issuer.log; exit 1; }
  /work/traefik --configFile=/work/traefik.yaml > /work/traefik.log 2>&1 &
  proxy_pid=$!
  for attempt in $(seq 1 15); do
    if curl -kfsS https://agent-42-18789.prod.clawdi.test:19444/readyz >/dev/null 2>&1; then break; fi
    if ! kill -0 "$proxy_pid" 2>/dev/null; then cat /work/traefik.log; exit 1; fi
    sleep 1
  done
  curl -kfsS https://agent-42-18789.prod.clawdi.test:19444/readyz >/dev/null || { cat /work/traefik.log; exit 1; }
  cd /work/clawdi
  export E2E_HOSTED_BASE_URL=https://cloud.clawdi.test:19444
  export E2E_HOSTED_DEPLOY_API_URL=https://api.clawdi.test:19444
  export E2E_HOSTED_CLOUD_API_URL=https://cloud-api.clawdi.test:19444
  bun run --cwd apps/web e2e --config=playwright.openclaw.config.ts --grep "protected runtime owner" || { cat /work/browser-issuer.log /work/traefik.log; exit 1; }
  VITE_CLAWDI_HOSTED=true E2E_HOSTED_DEPLOY_API_URL=http://127.0.0.1:50021 E2E_HOSTED_CLOUD_API_URL=http://127.0.0.1:8000 bun run --cwd apps/web e2e --config=playwright.auth.config.ts --grep "OpenClaw (grant|retires late)"
  bun run --cwd apps/web e2e --config=playwright.openclaw.config.ts --grep-invert "protected runtime owner"
  uv run --project /work/hosted/backend --frozen python /work/hosted/backend/scripts/check_python_types.py
else
bun run --cwd apps/web e2e --config=playwright.openclaw.config.ts
fi
bun run --cwd apps/web typecheck
'
