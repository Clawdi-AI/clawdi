#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${CLAWDI_AI_PROVIDER_SMOKE_IMAGE:-node:24-bookworm-slim}"

docker run --rm -i \
  -v "${repo_root}:/repo:ro" \
  -w /tmp \
  "${image}" \
  bash -s <<'CONTAINER'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NO_COLOR=1

step() {
  echo "[smoke] $*" >&2
}

dump_failure_logs() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- failure logs ---" >&2
    for f in \
      /tmp/apt.log \
      /tmp/npm-install.log \
      /tmp/hermes-pip.log \
      /tmp/bun-install.log \
      /tmp/fake-provider.log \
      /tmp/add.json \
      /tmp/auth-test.json \
      /tmp/live-test.json \
      /tmp/export.out \
      /tmp/import.json \
      /tmp/codex-apply.json \
      /tmp/codex-exec.out \
      /tmp/codex-exec.err \
      /tmp/hermes-apply.json \
      /tmp/hermes-smoke.json \
      /tmp/openclaw-apply.json \
      /tmp/openclaw-provider.json \
      /tmp/openclaw-default.json \
      /tmp/ai-provider-smoke-summary.json \
      /tmp/fake-provider-requests.jsonl; do
      if [ -f "$f" ]; then
        echo "--- ${f} ---" >&2
        tail -120 "$f" >&2 || true
      fi
    done
  fi
  exit "$rc"
}
trap dump_failure_logs EXIT

step "installing system packages"
apt-get update >/tmp/apt.log 2>&1
apt-get install -y git python3 python3-venv >/tmp/apt.log 2>&1

step "installing pinned agent CLIs"
npm install -g \
  bun@1.3.14 \
  openclaw@2026.5.28 \
  @openai/codex@0.136.0 >/tmp/npm-install.log 2>&1

step "installing pinned Hermes package"
python3 -m venv /tmp/hermes-venv
/tmp/hermes-venv/bin/python -m pip install --upgrade pip >/tmp/hermes-pip.log 2>&1
/tmp/hermes-venv/bin/python -m pip install hermes-agent==0.15.2 >>/tmp/hermes-pip.log 2>&1

step "copying repository and installing CLI workspace dependencies"
mkdir -p /tmp/repo
tar --exclude=node_modules --exclude=.git --exclude=.next --exclude=.turbo \
  -cf - -C /repo . | tar -xf - -C /tmp/repo
cd /tmp/repo
git init >/tmp/git-init.log 2>&1
git config --global --add safe.directory /tmp/repo
cat >package.json <<'JSON'
{
  "name": "clawdi-ai-provider-smoke-workspace",
  "private": true,
  "workspaces": [
    "packages/cli",
    "packages/shared"
  ],
  "catalog": {
    "typescript": "^5.9.0"
  },
  "packageManager": "bun@1.3.14"
}
JSON
rm -f bun.lock
bun install \
  --ignore-scripts \
  --omit optional \
  --network-concurrency 8 >/tmp/bun-install.log 2>&1

step "starting fake OpenAI-compatible provider"
cat >/tmp/fake-provider.mjs <<'NODE'
import http from "node:http";
import fs from "node:fs";

const logPath = "/tmp/fake-provider-requests.jsonl";
const readyPath = "/tmp/fake-provider-ready";

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function writeSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const events = [
    { type: "response.created", response: { id: "resp-smoke" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg-smoke",
        content: [{ type: "output_text", text: "clawdi smoke ok" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-smoke",
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
          total_tokens: 2,
        },
      },
    },
  ];
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: bodyText ? JSON.parse(bodyText) : null,
      })}\n`,
    );
    if (req.method === "GET" && req.url === "/v1/models") {
      writeJson(res, 200, {
        object: "list",
        data: [{ id: "gpt-5.2", object: "model", owned_by: "clawdi-smoke" }],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      writeSse(res);
      return;
    }
    writeJson(res, 404, { error: { message: `unexpected ${req.method} ${req.url}` } });
  });
});

server.listen(18080, "127.0.0.1", () => {
  fs.writeFileSync(readyPath, "ready");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
NODE

node /tmp/fake-provider.mjs >/tmp/fake-provider.log 2>&1 &
fake_provider_pid=$!
for _ in $(seq 1 50); do
  [ -f /tmp/fake-provider-ready ] && break
  sleep 0.1
done
test -f /tmp/fake-provider-ready

step "creating provider and running Clawdi CLI checks"
CLI=(bun run packages/cli/src/index.ts)
SECRET="sk-smoke-secret-value"
PASSPHRASE="isolated-ai-provider-passphrase"
SRC_HOME=/tmp/src-home
DST_HOME=/tmp/dst-home
SRC_CLAWDI=/tmp/src-clawdi
DST_CLAWDI=/tmp/dst-clawdi
CODEX_HOME=/tmp/codex-home
HERMES_HOME=/tmp/hermes-home
OPENCLAW_STATE_DIR=/tmp/openclaw-state
EXPORT_FILE=/tmp/ai-providers-with-secrets.json
ENV_FILE=/tmp/providers.env
mkdir -p \
  "$SRC_HOME" \
  "$DST_HOME" \
  "$SRC_CLAWDI" \
  "$DST_CLAWDI" \
  "$CODEX_HOME" \
  "$HERMES_HOME" \
  "$OPENCLAW_STATE_DIR"

printf 'model = "user-existing-model"\n' > "$CODEX_HOME/config.toml"
cat >"$HERMES_HOME/config.yaml" <<'YAML'
# user hermes config
mcp_servers:
  clawdi:
    command: clawdi # keep this comment
model: old-model
providers:
YAML

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  "${CLI[@]}" ai-provider add openai-main \
  --type openai \
  --base-url http://127.0.0.1:18080/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth env:OPENAI_API_KEY \
  --set-default \
  --json >/tmp/add.json

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  "${CLI[@]}" ai-provider test openai-main --json >/tmp/auth-test.json

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  "${CLI[@]}" ai-provider test openai-main --live --timeout 5 --json >/tmp/live-test.json

if grep -q "$SECRET" /tmp/add.json /tmp/auth-test.json /tmp/live-test.json; then
  echo "secret leaked in add/test output" >&2
  exit 1
fi

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  CLAWDI_SECRET_EXPORT_PASSPHRASE="$PASSPHRASE" \
  "${CLI[@]}" ai-provider export \
  --out "$EXPORT_FILE" \
  --include-secrets \
  --secret-passphrase >/tmp/export.out

if grep -q "$SECRET" "$EXPORT_FILE" /tmp/export.out; then
  echo "secret leaked into export" >&2
  exit 1
fi

HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" \
  CLAWDI_SECRET_EXPORT_PASSPHRASE="$PASSPHRASE" \
  "${CLI[@]}" ai-provider import "$EXPORT_FILE" \
  --import-secrets env-file \
  --out "$ENV_FILE" \
  --json >/tmp/import.json

grep -q "OPENAI_API_KEY" "$ENV_FILE"
grep -q "$SECRET" "$ENV_FILE"

step "applying Codex projection"
HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" CODEX_HOME="$CODEX_HOME" \
  "${CLI[@]}" ai-provider apply --engine codex --json >/tmp/codex-apply.json

test -f "$CODEX_HOME/clawdi-ai-provider.config.toml"
grep -q "user-existing-model" "$CODEX_HOME/config.toml"
if grep -q "$SECRET" "$CODEX_HOME/clawdi-ai-provider.config.toml" /tmp/codex-apply.json; then
  echo "secret leaked into codex projection" >&2
  exit 1
fi

step "applying Hermes projection and loading it with Hermes"
HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" HERMES_HOME="$HERMES_HOME" \
  "${CLI[@]}" ai-provider apply --engine hermes --json >/tmp/hermes-apply.json

if grep -q "$SECRET" "$HERMES_HOME/config.yaml" /tmp/hermes-apply.json; then
  echo "secret leaked into hermes config or apply output" >&2
  exit 1
fi

HERMES_HOME="$HERMES_HOME" OPENAI_API_KEY="$SECRET" /tmp/hermes-venv/bin/python - <<'PY' >/tmp/hermes-smoke.json
import json
from hermes_cli.config import get_compatible_custom_providers, load_config
from hermes_cli.runtime_provider import _get_model_config, _get_named_custom_provider

cfg = load_config()
model = _get_model_config()
custom = get_compatible_custom_providers(cfg)
named = _get_named_custom_provider("custom:openai-main")

assert cfg["model"]["provider"] == "custom:openai-main"
assert cfg["model"]["default"] == "gpt-5.2"
assert cfg["providers"]["openai-main"]["api"] == "http://127.0.0.1:18080/v1"
assert cfg["providers"]["openai-main"]["transport"] == "codex_responses"
assert cfg["providers"]["openai-main"]["key_env"] == "OPENAI_API_KEY"
assert model["provider"] == "custom:openai-main"
assert named["base_url"] == "http://127.0.0.1:18080/v1"
assert named["model"] == "gpt-5.2"
assert named["api_mode"] == "codex_responses"
assert named["api_key"] == "sk-smoke-secret-value"
assert any(entry.get("provider_key") == "openai-main" for entry in custom)

print(json.dumps({
    "ok": True,
    "model_provider": cfg["model"]["provider"],
    "provider_api": cfg["providers"]["openai-main"]["api"],
    "transport": named["api_mode"],
    "mcp_preserved": "clawdi" in cfg.get("mcp_servers", {}),
    "comment_preserved": "keep this comment" in open("/tmp/hermes-home/config.yaml").read(),
}, indent=2))
PY

step "applying OpenClaw projection and reading it with OpenClaw"
HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  "${CLI[@]}" ai-provider apply --engine openclaw --json >/tmp/openclaw-apply.json

HOME="$DST_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  openclaw config get models.providers.openai-main --json >/tmp/openclaw-provider.json
HOME="$DST_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  openclaw config get agents.defaults.model.primary --json >/tmp/openclaw-default.json

step "running Codex exec against fake provider"
OPENAI_API_KEY="$SECRET" CODEX_HOME="$CODEX_HOME" \
  timeout 45s codex exec \
  --profile clawdi-ai-provider \
  --skip-git-repo-check \
  --sandbox read-only \
  -C /tmp/repo \
  "Say exactly: clawdi smoke ok" </dev/null >/tmp/codex-exec.out 2>/tmp/codex-exec.err

grep -q "clawdi smoke ok" /tmp/codex-exec.out

step "validating smoke artifacts"
node - <<'NODE' >/tmp/ai-provider-smoke-summary.json
const fs = require("fs");
const secret = "sk-smoke-secret-value";
const add = JSON.parse(fs.readFileSync("/tmp/add.json", "utf8"));
const authTest = JSON.parse(fs.readFileSync("/tmp/auth-test.json", "utf8"));
const liveTest = JSON.parse(fs.readFileSync("/tmp/live-test.json", "utf8"));
const imported = JSON.parse(fs.readFileSync("/tmp/import.json", "utf8"));
const codexApply = JSON.parse(fs.readFileSync("/tmp/codex-apply.json", "utf8"));
const hermesApply = JSON.parse(fs.readFileSync("/tmp/hermes-apply.json", "utf8"));
const hermesSmoke = JSON.parse(fs.readFileSync("/tmp/hermes-smoke.json", "utf8"));
const openclawApply = JSON.parse(fs.readFileSync("/tmp/openclaw-apply.json", "utf8"));
const provider = JSON.parse(fs.readFileSync("/tmp/openclaw-provider.json", "utf8"));
const def = JSON.parse(fs.readFileSync("/tmp/openclaw-default.json", "utf8"));
const codexProfile = fs.readFileSync("/tmp/codex-home/clawdi-ai-provider.config.toml", "utf8");
const codexStdout = fs.readFileSync("/tmp/codex-exec.out", "utf8");
const requestLog = fs
  .readFileSync("/tmp/fake-provider-requests.jsonl", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const rawWithoutEnvFile = JSON.stringify({
  add,
  authTest,
  liveTest,
  imported,
  codexApply,
  hermesApply,
  hermesSmoke,
  openclawApply,
  provider,
  def,
  codexProfile,
  codexStdout,
});
if (rawWithoutEnvFile.includes(secret)) throw new Error("secret leaked into CLI/runtime outputs");
if (authTest.provider_probe?.status !== "skipped") throw new Error("default ai-provider test should skip live probe");
if (liveTest.provider_probe?.status !== "ok") throw new Error("live provider probe failed");
if (imported.imported !== 1) throw new Error("import count mismatch");
if (!codexProfile.includes("model_provider")) throw new Error("codex profile missing model_provider");
if (!codexProfile.includes('base_url = "http://127.0.0.1:18080/v1"')) {
  throw new Error("codex profile missing fake provider base URL");
}
const openclawPatch = JSON.parse(openclawApply.commands[0].stdin);
if (openclawPatch.models.providers["openai-main"].apiKey.id !== "OPENAI_API_KEY") {
  throw new Error("OpenClaw patch did not use env ref");
}
const value = provider.value ?? provider;
const defaultValue = def.value ?? def;
const modelIds = Array.isArray(value.models) ? value.models.map((model) => model.id) : [];
if (value.api !== "openai-responses") throw new Error("OpenClaw provider API mismatch");
if (value.baseUrl !== "http://127.0.0.1:18080/v1") throw new Error("OpenClaw provider base URL mismatch");
if (!modelIds.includes("gpt-5.2")) throw new Error("OpenClaw model missing");
if (defaultValue !== "openai-main/gpt-5.2") throw new Error("OpenClaw default mismatch");
const modelsProbe = requestLog.find((entry) => entry.method === "GET" && entry.url === "/v1/models");
const responsesCall = requestLog.find((entry) => entry.method === "POST" && entry.url === "/v1/responses");
if (!modelsProbe) throw new Error("fake provider did not receive /v1/models live probe");
if (!responsesCall) throw new Error("fake provider did not receive /v1/responses from Codex");
if (modelsProbe.authorization !== `Bearer ${secret}`) throw new Error("live probe did not use env secret");
if (responsesCall.authorization !== `Bearer ${secret}`) throw new Error("Codex did not use env secret");
if (responsesCall.body?.model !== "gpt-5.2") throw new Error("Codex request model mismatch");
console.log(JSON.stringify({
  ok: true,
  image: "node:24-bookworm-slim",
  bun: "1.3.14",
  codex: "0.136.0",
  openclaw: "2026.5.28",
  hermes: "0.15.2",
  addProvider: add.added,
  defaultProbe: authTest.provider_probe.status,
  liveProbe: liveTest.provider_probe.status,
  importedProviders: imported.imported,
  codexProfileWritten: true,
  codexExecReachedFakeProvider: true,
  codexExecOutput: codexStdout.trim().split("\n").slice(-1)[0],
  hermesConfigLoadedByHermes: hermesSmoke.ok,
  hermesTransport: hermesSmoke.transport,
  hermesMcpPreserved: hermesSmoke.mcp_preserved,
  openclawDefaultModel: defaultValue,
  openclawProviderApi: value.api,
  openclawModels: modelIds,
  fakeProviderRequests: requestLog.map((entry) => `${entry.method} ${entry.url}`),
  secretLeakedInOutputs: false
}, null, 2));
NODE

if [ ! -s /tmp/ai-provider-smoke-summary.json ]; then
  echo "smoke summary was empty" >&2
  exit 1
fi

cat /tmp/ai-provider-smoke-summary.json
step "complete"

kill "$fake_provider_pid" 2>/dev/null || true
CONTAINER
