# AI Providers

AI Provider is Clawdi's portable model-provider layer. It stores provider
metadata, auth references, and agent capabilities once, then applies the
engine-specific config changes that Codex, Hermes, OpenClaw, or hosted agent
setup can consume.

The important boundary: Clawdi does not proxy BYOK model traffic. Agents and
tools call OpenAI, Anthropic, OpenRouter, Gemini, Mistral, or your custom
endpoint directly. Clawdi may store secrets, resolve `clawdi://` references, or
materialize local auth files, but it is not in the model request path.

## What Works Today

Supported provider types:

- `openai`
- `anthropic`
- `openrouter`
- `gemini`
- `mistral`
- `custom_openai_compatible`

Supported auth surfaces:

- `env:<NAME>` secret refs.
- `clawdi://...` Vault refs.
- `none` for loopback or private local endpoints.
- Codex OAuth, stored as an encrypted Codex `agent_profile`.
- Imported Codex auth profiles through `ai-provider import-auth`.

Supported catalog fields for v1 apply:

- Provider identity: `id`, `type`, `label`.
- Endpoint/protocol: `base_url`, `api_mode`, `default_model`.
- Auth indirection: `auth`, plus optional `runtime_env_name` for agents that
  need an env var name.
- Declarative metadata: `capabilities`.
- Optional model metadata through JSON catalog import: `models[].id`,
  `models[].label`, `models[].api_mode`, `models[].input_modalities`,
  `models[].context_window`, and `models[].max_tokens`. Today this is projected
  only where the pinned agent contract supports it, such as OpenClaw model
  entries.

Agent apply status:

| Agent engine | Status | User launch path |
| --- | --- | --- |
| Codex | Enabled | `clawdi ai-provider apply --engine codex`, then `codex --profile clawdi-ai-provider` |
| Hermes | Enabled | `clawdi ai-provider apply --engine hermes` merges `$HERMES_HOME/config.yaml` |
| OpenClaw | Enabled | `clawdi ai-provider apply --engine openclaw` uses `openclaw config patch --stdin` |

Pinned agent contracts are documented in
[`docs/ai-provider-agent-contract-audit.md`](./ai-provider-agent-contract-audit.md).

OAuth status:

| Tool | Status |
| --- | --- |
| Codex | Enabled, pinned to the official Codex OAuth flow |
| Claude Code | Not supported in AI Provider v1; use an Anthropic API key/env/Vault provider |
| Other tools/providers | Not enabled until their public OAuth/config contracts are pinned |

## Add An Env-Backed Provider

Use this when the key already exists in your shell or deployment environment:

```bash
clawdi ai-provider add openai-main \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth env:OPENAI_API_KEY \
  --set-default

clawdi ai-provider validate openai-main
clawdi ai-provider test openai-main
clawdi ai-provider test openai-main --live
```

The catalog stores `env:OPENAI_API_KEY`, not the key value.

## Add A Vault-Backed Provider

Use this when the key lives in Clawdi Vault:

```bash
clawdi ai-provider add openai-vault \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth clawdi://default/OPENAI_API_KEY \
  --agent-env OPENAI_API_KEY

clawdi ai-provider test openai-vault
clawdi ai-provider test openai-vault --live
```

`clawdi://` resolution may call Clawdi Vault from the CLI. The provider probe
only calls the provider API directly when `--live` is passed; it is not a Clawdi
model proxy.

## Add An Anthropic Provider

Claude Code OAuth is intentionally not part of AI Provider v1. For Anthropic,
use a normal provider with an Anthropic key:

```bash
clawdi ai-provider add anthropic-main \
  --type anthropic \
  --base-url https://api.anthropic.com \
  --default-model claude-opus-4-6 \
  --api-mode anthropic_messages \
  --auth env:ANTHROPIC_API_KEY

clawdi ai-provider validate anthropic-main
clawdi ai-provider test anthropic-main
```

Running `clawdi ai-provider connect anthropic-main --tool claude-code` returns a
clear unsupported error. That is expected.

## Use Codex OAuth

Codex OAuth is the first enabled OAuth adapter because its public contract is
pinned: authorization URL, client ID, scopes, loopback redirect, token exchange,
and `auth.json` shape.

```bash
clawdi ai-provider add openai-codex \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth env:OPENAI_API_KEY

clawdi ai-provider connect openai-codex --tool codex
clawdi ai-provider materialize-auth openai-codex
clawdi ai-provider apply --engine codex
codex --profile clawdi-ai-provider
```

Default behavior:

- The CLI listens on `http://localhost:1455/auth/callback`.
- If port `1455` is unavailable, it tries `1457`.
- If local loopback is unavailable, use manual completion:

```bash
clawdi ai-provider connect openai-codex --tool codex --callback manual
clawdi ai-provider complete-oauth openai-codex --redirect-url '<browser callback url>'
```

OAuth tokens are stored as encrypted provider-auth payloads. They are not printed
or stored inside the Provider Catalog.

For Codex OAuth, `ai-provider apply --engine codex` uses Codex's built-in
OpenAI provider and does not write a fixed `model` value into the generated
profile. Codex then selects the default model supported by the signed-in
ChatGPT/Codex account for the pinned CLI version.

## Apply Codex

Codex apply does not edit your primary `$CODEX_HOME/config.toml`. Clawdi writes
the profile file Codex can read:

```text
$CODEX_HOME/clawdi-ai-provider.config.toml
```

Then launch Codex with:

```bash
codex --profile clawdi-ai-provider
```

Supported contract:

```text
@openai/codex 0.134.0 through 0.136.0 with profile config, model_providers, and responses wire_api support
```

Codex apply requires Responses-compatible providers. Chat-only providers cannot
be applied to Codex.

Preview first:

```bash
clawdi ai-provider apply --engine codex --dry-run
```

## Apply Hermes

Hermes apply does a structured merge into `$HERMES_HOME/config.yaml`:

```bash
clawdi ai-provider apply --engine hermes --dry-run
clawdi ai-provider apply --engine hermes
```

The merge writes Hermes' verified `providers` dict shape and selects the default
provider with `model.provider: custom:<provider-id>`. Existing unrelated Hermes
config sections, such as `mcp_servers`, are preserved. Clawdi does not print or
copy existing inline Hermes secrets during dry-run; dry-run prints only the
generated provider patch.

Supported contract:

```text
Hermes Agent 0.13.0 through 0.15.2 with providers dict compatibility
```

Hermes custom-provider transports supported by AI Provider apply:

- `openai_chat` -> `chat_completions`
- `openai_responses` -> `codex_responses`
- `anthropic_messages` -> `anthropic_messages`

`google_generate_content` is not projected to Hermes custom providers in v1.
Use OpenClaw for native Gemini projection, or configure Hermes' own Gemini
provider outside AI Provider until that contract is added.

## Advanced Provider Settings

AI Provider v1 intentionally does not try to normalize every provider-native
setting. The following stay outside the portable catalog until each target
agent's contract is pinned and tested:

- Static or env-backed custom HTTP headers, such as OpenRouter attribution
  headers or OpenAI organization/project headers.
- Query parameters, such as Azure `api-version`.
- Provider-specific request options, retries, timeouts, proxies, or extra
  request bodies.
- Agent-specific plugin settings or native provider blocks that are not part of
  the verified apply contract.

For launch, keep those settings in the agent's native config. Clawdi apply is
designed to preserve unrelated native config. For Hermes, the structured merge
keeps existing provider fields that Clawdi does not own, such as `extra_body`,
while replacing stale generated fields and inline `api_key` values for managed
provider IDs.

## OpenClaw Status

OpenClaw apply uses OpenClaw's native config patch CLI:

```bash
clawdi ai-provider apply --engine openclaw --dry-run
clawdi ai-provider apply --engine openclaw
```

Supported contract:

```text
openclaw 2026.5.12, 2026.5.18, 2026.5.27, and 2026.5.28 config patch contract
```

Clawdi sends a patch over stdin instead of editing OpenClaw config files
directly. The patch uses `models.mode: "merge"`,
`models.providers.<id>.apiKey` env refs, and
`agents.defaults.model.primary`.

## Local No-Auth Endpoint

No-auth providers are allowed for loopback and private local model endpoints:

```bash
clawdi ai-provider add lmstudio-local \
  --type custom_openai_compatible \
  --base-url http://127.0.0.1:1234/v1 \
  --api-mode openai_chat \
  --default-model local-model \
  --auth none

clawdi ai-provider validate lmstudio-local
```

Public no-auth URLs are rejected by default.

## Import Existing Agent Config

Import providers from Hermes:

```bash
clawdi ai-provider import --from-hermes ~/.hermes/config.yaml
clawdi ai-provider validate
```

Import a Clawdi-generated OpenClaw provider config:

```bash
clawdi ai-provider import --from-openclaw ./openclaw-provider-config.json
```

Imports are additive by default. Use `--replace` only when you want incoming
provider IDs to overwrite existing providers.

## Import Or Materialize A Local Auth Profile

Existing credential profile commands are moving under AI Provider auth when the
target contract is pinned. Codex is the supported AI Provider auth target in v1:

```bash
clawdi ai-provider import-auth openai-codex --tool codex
clawdi ai-provider materialize-auth openai-codex
```

Claude Code credential sync remains on the legacy `clawdi agent credentials`
path until its public credential and OAuth contracts are pinned.

## Export And Import Provider Catalogs

Default export includes provider metadata and secret references only:

```bash
clawdi ai-provider export --out ai-providers.json
clawdi ai-provider import ai-providers.json
```

It does not export plaintext keys.

To include env-backed secrets, explicitly request encrypted secret export:

```bash
export CLAWDI_SECRET_EXPORT_PASSPHRASE='choose-a-strong-passphrase'
clawdi ai-provider export \
  --out ai-providers-with-secrets.json \
  --include-secrets \
  --secret-passphrase
```

Import encrypted env-backed secrets into an owner-only env file:

```bash
export CLAWDI_SECRET_EXPORT_PASSPHRASE='choose-a-strong-passphrase'
clawdi ai-provider import ai-providers-with-secrets.json \
  --import-secrets env-file \
  --out .env.ai-providers
```

Do not commit imported env files.

## Inspect And Diagnose

```bash
clawdi ai-provider list
clawdi ai-provider validate
clawdi ai-provider status
clawdi doctor ai-provider
```

`ai-provider test` checks auth availability and direct provider reachability. It
does not call the provider by default. Pass `--live` to run an optional direct
provider metadata probe. It redacts secrets and prints provider/probe status,
not raw request bodies.

The isolated pre-merge test record is in
[`docs/ai-provider-isolated-e2e.md`](./ai-provider-isolated-e2e.md).

## Current Non-Goals

These are not current user experiences:

- Clawdi-proxied BYOK model requests.
- Claude Code OAuth through AI Provider.
- Dashboard onboarding UI for AI Providers.
- A CLI daemon/RPC surface for hosted agents to invoke local materialization.
- OAuth for Anthropic, Gemini, OpenRouter, Mistral, or arbitrary custom
  providers.
