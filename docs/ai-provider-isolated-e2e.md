# AI Provider Isolated E2E Test Record

This document records the isolated end-to-end test used before merging the
first non-UI AI Provider slice.

## Recorded Run

- Date: 2026-06-02
- Branch: `feat/ai-provider-abstraction`
- Commit: `70538dd0 Align AI Provider export import semantics`
- Container image: `node:24-bookworm-slim`
- Container-only installs:
  - `bun@1.3.14`
  - `openclaw@2026.5.28`
  - Debian `git`
- Repository mount: read-only at `/repo`
- Runtime copy: `/tmp/repo` inside the container
- Isolated homes:
  - `HOME=/tmp/src-home` for the source catalog
  - `HOME=/tmp/dst-home` for the destination catalog and agent apply
  - `CLAWDI_HOME=/tmp/src-clawdi` and `/tmp/dst-clawdi`
  - `CODEX_HOME=/tmp/codex-home`
  - `OPENCLAW_STATE_DIR=/tmp/openclaw-state`
- Test secret: fake value `sk-isolated-secret-value`

## Covered User Flows

1. Add an env-backed OpenAI provider:
   - `clawdi ai-provider add openai-main`
   - Auth stored as `env:OPENAI_API_KEY`, not plaintext.
2. Run default provider test:
   - `clawdi ai-provider test openai-main --json`
   - Verifies auth availability.
   - Confirms live probe is skipped unless `--live` is passed.
3. Export provider catalog with encrypted env-backed secrets:
   - `clawdi ai-provider export --include-secrets --secret-passphrase`
   - Confirms the export file does not contain the fake secret.
4. Import provider catalog and encrypted secret bundle into a new isolated home:
   - `clawdi ai-provider import ... --import-secrets env-file`
   - Confirms one provider is imported.
   - Confirms the env file contains `OPENAI_API_KEY` and is the only plaintext
     materialization target.
5. Apply Codex config:
   - `clawdi ai-provider apply --engine codex`
   - Confirms `$CODEX_HOME/clawdi-ai-provider.config.toml` is written.
   - Confirms `$CODEX_HOME/config.toml` is preserved.
   - Confirms the fake secret is not written to Codex config or CLI output.
6. Apply OpenClaw config through the real OpenClaw CLI:
   - `clawdi ai-provider apply --engine openclaw`
   - Uses `openclaw config patch --stdin`.
   - Reads back `models.providers.openai-main`.
   - Reads back `agents.defaults.model.primary`.
   - Confirms the provider uses `openai-responses`.
   - Confirms default model is `openai-main/gpt-5.2`.
   - Confirms the patch uses the env ref `OPENAI_API_KEY`.
   - Confirms the fake secret is not present in CLI/runtime output.

## Final Result

The final isolated run exited with code `0` and printed:

```json
{
  "ok": true,
  "image": "node:24-bookworm-slim",
  "bun": "1.3.14",
  "openclaw": "2026.5.28",
  "addProvider": "openai-main",
  "defaultProbe": "skipped",
  "encryptedExportSecretLeaked": false,
  "importedProviders": 1,
  "codexProfileWritten": true,
  "codexPrimaryConfigPreserved": true,
  "openclawDefaultModel": "openai-main/gpt-5.2",
  "openclawProviderApi": "openai-responses",
  "openclawModels": ["gpt-5.2"],
  "openclawEnvRefInPatch": true,
  "secretLeakedInOutputs": false
}
```

## Re-run Command

Run from the repository root:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /tmp node:24-bookworm-slim bash -lc '
set -euo pipefail
trap '\''rc=$?; if [ $rc -ne 0 ]; then
  echo "--- failure logs ---"
  echo "apt:"; tail -30 /tmp/apt.log 2>/dev/null || true
  echo "npm:"; tail -30 /tmp/npm-install.log 2>/dev/null || true
  echo "bun:"; tail -80 /tmp/bun-install.log 2>/dev/null || true
  echo "add:"; cat /tmp/add.json 2>/dev/null || true
  echo "auth-test:"; cat /tmp/auth-test.json 2>/dev/null || true
  echo "export:"; cat /tmp/export.out 2>/dev/null || true
  echo "import:"; cat /tmp/import.json 2>/dev/null || true
  echo "codex-apply:"; cat /tmp/codex-apply.json 2>/dev/null || true
  echo "openclaw-apply:"; cat /tmp/openclaw-apply.json 2>/dev/null || true
  echo "openclaw-provider:"; cat /tmp/openclaw-provider.json 2>/dev/null || true
  echo "openclaw-default:"; cat /tmp/openclaw-default.json 2>/dev/null || true
fi; exit $rc'\'' EXIT

apt-get update >/tmp/apt.log 2>&1
apt-get install -y git >/tmp/apt.log 2>&1
npm install -g bun@1.3.14 openclaw@2026.5.28 >/tmp/npm-install.log 2>&1

mkdir -p /tmp/repo
tar --exclude=node_modules --exclude=.git --exclude=.next --exclude=.turbo \
  -cf - -C /repo . | tar -xf - -C /tmp/repo
cd /tmp/repo
git init >/tmp/git-init.log 2>&1
git config --global --add safe.directory /tmp/repo
bun install --frozen-lockfile >/tmp/bun-install.log 2>&1

CLI=(bun run packages/cli/src/index.ts)
SECRET="sk-isolated-secret-value"
PASSPHRASE="isolated-ai-provider-passphrase"
SRC_HOME=/tmp/src-home
DST_HOME=/tmp/dst-home
SRC_CLAWDI=/tmp/src-clawdi
DST_CLAWDI=/tmp/dst-clawdi
CODEX_HOME=/tmp/codex-home
OPENCLAW_STATE_DIR=/tmp/openclaw-state
EXPORT_FILE=/tmp/ai-providers-with-secrets.json
ENV_FILE=/tmp/providers.env
mkdir -p "$SRC_HOME" "$DST_HOME" "$SRC_CLAWDI" "$DST_CLAWDI" "$CODEX_HOME" "$OPENCLAW_STATE_DIR"
printf '\''model = "user-existing-model"\n'\'' > "$CODEX_HOME/config.toml"

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  "${CLI[@]}" ai-provider add openai-main \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth env:OPENAI_API_KEY \
  --set-default \
  --json >/tmp/add.json

HOME="$SRC_HOME" CLAWDI_HOME="$SRC_CLAWDI" OPENAI_API_KEY="$SECRET" \
  "${CLI[@]}" ai-provider test openai-main --json >/tmp/auth-test.json

if grep -q "$SECRET" /tmp/add.json /tmp/auth-test.json; then
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

if ! grep -q "OPENAI_API_KEY" "$ENV_FILE"; then
  echo "env import missing OPENAI_API_KEY" >&2
  exit 1
fi
if ! grep -q "$SECRET" "$ENV_FILE"; then
  echo "env import missing secret value" >&2
  exit 1
fi

HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" CODEX_HOME="$CODEX_HOME" \
  "${CLI[@]}" ai-provider apply --engine codex --json >/tmp/codex-apply.json

test -f "$CODEX_HOME/clawdi-ai-provider.config.toml"
grep -q "user-existing-model" "$CODEX_HOME/config.toml"
if grep -q "$SECRET" "$CODEX_HOME/clawdi-ai-provider.config.toml" /tmp/codex-apply.json; then
  echo "secret leaked into codex projection" >&2
  exit 1
fi

HOME="$DST_HOME" CLAWDI_HOME="$DST_CLAWDI" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  "${CLI[@]}" ai-provider apply --engine openclaw --json >/tmp/openclaw-apply.json

HOME="$DST_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  openclaw config get models.providers.openai-main --json >/tmp/openclaw-provider.json
HOME="$DST_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  openclaw config get agents.defaults.model.primary --json >/tmp/openclaw-default.json

node - <<'\''NODE'\''
const fs = require("fs");
const secret = "sk-isolated-secret-value";
const add = JSON.parse(fs.readFileSync("/tmp/add.json", "utf8"));
const authTest = JSON.parse(fs.readFileSync("/tmp/auth-test.json", "utf8"));
const imported = JSON.parse(fs.readFileSync("/tmp/import.json", "utf8"));
const codexApply = JSON.parse(fs.readFileSync("/tmp/codex-apply.json", "utf8"));
const openclawApply = JSON.parse(fs.readFileSync("/tmp/openclaw-apply.json", "utf8"));
const provider = JSON.parse(fs.readFileSync("/tmp/openclaw-provider.json", "utf8"));
const def = JSON.parse(fs.readFileSync("/tmp/openclaw-default.json", "utf8"));
const codexProfile = fs.readFileSync("/tmp/codex-home/clawdi-ai-provider.config.toml", "utf8");
const raw = JSON.stringify({ add, authTest, imported, codexApply, openclawApply, provider, def, codexProfile });
if (raw.includes(secret)) throw new Error("secret leaked into CLI/runtime output");
if (authTest.provider_probe?.status !== "skipped") throw new Error("default ai-provider test should skip live probe");
if (imported.imported !== 1) throw new Error("import count mismatch");
if (!codexProfile.includes("model_provider")) throw new Error("codex profile missing model_provider");
const patch = JSON.parse(openclawApply.commands[0].stdin);
if (patch.models.providers["openai-main"].apiKey.id !== "OPENAI_API_KEY") {
  throw new Error("OpenClaw patch did not use env ref");
}
const value = provider.value ?? provider;
const defaultValue = def.value ?? def;
const modelIds = Array.isArray(value.models) ? value.models.map((model) => model.id) : [];
if (value.api !== "openai-responses") throw new Error("OpenClaw provider API mismatch");
if (!modelIds.includes("gpt-5.2")) throw new Error("OpenClaw model missing");
if (defaultValue !== "openai-main/gpt-5.2") throw new Error("OpenClaw default mismatch");
console.log(JSON.stringify({
  ok: true,
  image: "node:24-bookworm-slim",
  bun: "1.3.14",
  openclaw: "2026.5.28",
  addProvider: add.added,
  defaultProbe: authTest.provider_probe.status,
  encryptedExportSecretLeaked: false,
  importedProviders: imported.imported,
  codexProfileWritten: true,
  codexPrimaryConfigPreserved: true,
  openclawDefaultModel: defaultValue,
  openclawProviderApi: value.api,
  openclawModels: modelIds,
  openclawEnvRefInPatch: true,
  secretLeakedInOutputs: false
}, null, 2));
NODE
'
```

## Not Covered By This Docker Run

- `ai-provider test --live`: intentionally not run because live probes require
  a real provider key and external billing/rate-limit behavior. This remains an
  optional user verification step.
- Codex OAuth against the real OpenAI authorization service: covered by backend
  and CLI tests with mocked token exchange and loopback/manual callback flows;
  real OAuth requires a browser and user account.
- Hermes native CLI execution: covered by command tests that verify
  `hermes config set` calls and preservation of unrelated `mcp_servers`
  config. This Docker run uses a real OpenClaw CLI because the OpenClaw install
  command and supported version are pinned here.
