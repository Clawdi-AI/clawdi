# AI Providers

AI Provider is Clawdi's portable model-provider metadata and Hosted runtime
projection layer. Provider Catalogs may contain many providers. A configured
Core Hosted runtime binds zero or one provider through its manifest; local
catalog storage and the public provider API remain multi-record surfaces.

Clawdi does not proxy BYOK model traffic. Hermes and OpenClaw call OpenAI,
Anthropic, OpenRouter, Gemini, Mistral, or a compatible endpoint directly.
Clawdi stores metadata and auth references, and the Hosted controller delivers
the selected provider through the stable runtime bootstrap bundle.

## Supported Provider Data

Supported provider types:

- `openai`
- `anthropic`
- `openrouter`
- `gemini`
- `mistral`
- `custom_openai_compatible`

Supported auth references:

- `env:<NAME>`
- `clawdi://...`
- `none` for loopback or private local endpoints
- Codex OAuth stored as an encrypted `agent_profile`
- imported Codex profiles through `ai-provider import-auth`

The catalog supports provider identity, `base_url`, `api_mode`,
`default_model`, capabilities, auth indirection, an optional runtime env name,
and optional model metadata. The canonical model limits are `context_window`,
`max_input_tokens`, and `max_tokens`. Managed OpenAI-compatible discovery also
accepts `context_length` and `max_output_tokens` as wire aliases; canonical
fields win when both forms are present.

Local catalog metadata lives in `~/.clawdi/ai-providers/catalog.json`. API keys
do not. A local catalog may contain several providers, and projection helpers
may model several target entries. Those facts do not widen a Core Hosted
runtime binding beyond one selected provider.

## Local Catalog Commands

Add and validate an env-backed provider:

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
```

`test` checks configuration and auth availability without a provider request.
Use `--live` only when a direct metadata probe is intended:

```bash
clawdi ai-provider test openai-main --live
```

Other current catalog commands are:

```bash
clawdi ai-provider list
clawdi ai-provider edit openai-main --default-model gpt-5.3
clawdi ai-provider remove openai-main
```

The local CLI does not activate or materialize provider configuration into a
local Codex, Hermes, or OpenClaw installation. Provider activation for Core
Hosted agents belongs to the Hosted manifest/controller path below.

Done: `bun run packages/cli/src/index.ts ai-provider --help` exits 0 and lists
`list`, `add`, `edit`, `remove`, `validate`, `test`, `connect`,
`complete-oauth`, `import-auth`, `export`, and `import`.

## Vault, No-Auth, And Anthropic

Vault-backed providers store only a reference in the catalog:

```bash
clawdi ai-provider add openai-vault \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth clawdi://default/OPENAI_API_KEY \
  --agent-env OPENAI_API_KEY
```

No-auth providers are accepted for loopback and private local endpoints:

```bash
clawdi ai-provider add lmstudio-local \
  --type custom_openai_compatible \
  --base-url http://127.0.0.1:1234/v1 \
  --api-mode openai_chat \
  --default-model local-model \
  --auth none
```

Public no-auth URLs are rejected by default. Hosted provider base URLs are
validated as public HTTPS URLs before projection.

Claude Code OAuth is not part of the current AI Provider surface. Use an
Anthropic API key, env, or Vault reference:

```bash
clawdi ai-provider add anthropic-main \
  --type anthropic \
  --base-url https://api.anthropic.com \
  --default-model claude-opus-4-6 \
  --api-mode anthropic_messages \
  --auth env:ANTHROPIC_API_KEY
```

## Codex OAuth Connection

Codex is the enabled OAuth source:

```bash
clawdi ai-provider add openai-codex \
  --type openai \
  --base-url https://api.openai.com/v1 \
  --default-model gpt-5.2 \
  --api-mode openai_responses \
  --auth env:OPENAI_API_KEY

clawdi ai-provider connect openai-codex --tool codex
```

The CLI listens on the supported loopback callbacks. For a headless flow:

```bash
clawdi ai-provider connect openai-codex --tool codex --callback manual
clawdi ai-provider complete-oauth openai-codex --redirect-url '<browser callback url>'
```

Existing Codex auth may be imported and bound to a provider:

```bash
clawdi ai-provider import-auth openai-codex --tool codex
```

OAuth tokens are stored as encrypted provider-auth payloads and are not stored
in the Provider Catalog or printed by these commands.

## Core Hosted Runtime Binding

The Hosted controller is the activation authority:

```text
provider catalog / auth payload
          |
          v
Hosted controller admission (provider_ids length 0..1)
          |
          v
stable runtime bootstrap bundle + scoped secretValues
          |
          v
CLI manifest validation before secret rendering/decryption
          |
          +--> Hermes config/auth convergence
          `--> OpenClaw config/provider-auth convergence
```

The wire field remains `provider_ids: string[]`. Its Core Hosted semantics are:

- configured mode contains exactly one provider ID;
- unmanaged mode contains an empty list;
- `primary_model.provider_id` must equal the configured provider ID;
- the manifest `providers` projection must exactly match the selected ID;
- changing selection replaces the binding; there is no fallback, secondary,
  toggle, or provider-pool ordering behavior.

The public REST provider arrays and their existing limits are separate API
debt and are not the Hosted binding contract. Provider Catalog CRUD likewise
remains multi-record.

The bootstrap response is the only Hosted wire used for convergence. Provider
selection does not alter that stable contract.

Done: `bun test packages/cli/src/runtime/manifest-reconciliation.test.ts`
exits 0 and includes rejection of multiple configured `provider_ids`.

## Hosted Hermes And OpenClaw Delivery

For Hermes, Hosted convergence performs a structured merge into
`$HERMES_HOME/config.yaml`. It preserves unrelated config, maps portable API
modes to Hermes transport names, and writes only environment-variable names
for API-key providers. Codex OAuth uses Hermes' native `openai-codex` selector
and a reserved Clawdi-owned credential-pool entry. Managed API-key provider
objects set the upstream-supported `discover_models: false` and explicitly map
the accepted-generation manifest's frozen `models`; each generation replaces
all generated provider fields, so removed models do not survive. Generic and
BYOK projection leaves Hermes' discovery default unchanged. Hermes has no
OpenClaw-style global `models.mode` switch.

This behavior is verified against Hermes `0.19.1`, source commit
[`cc4cab2f`](https://github.com/NousResearch/hermes-agent/tree/cc4cab2f592e60a197e796506de9168f74baf3ea):
[`model_switch.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/model_switch.py#L2613-L2658)
and its custom-provider path
[`model_switch.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/model_switch.py#L2791-L2942)
probe `/models` by default but honor `discover_models: false`;
[`config.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/config.py#L1310-L1321)
accepts that provider field.

For OpenClaw, Hosted provider convergence uses the public
`openclaw/plugin-sdk/config-mutation` export. The mutation starts from authored
source config, sets `models.mode` to `replace`, exactly replaces each selected
provider object, and leaves unrelated provider and user settings intact. In the
verified OpenClaw target, replace mode skips implicit provider discovery, so
the active managed catalog comes only from the manifest projection; replacing
the provider object also removes stale API modes and key references. The
mutation enables OpenClaw's targeted `allowConfigSizeDrop` write option because
removing stale managed models is an intentional size reduction; schema,
SecretRef preflight, config-path ownership, locking, and compare-and-swap guards
remain active. Gateway and channel patches continue to use `openclaw config
patch --stdin`.

This contract is verified against `openclaw@2026.7.1-2`, official source commit
[`0790d9f`](https://github.com/openclaw/openclaw/commit/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c).
The discovery skip is implemented in
[`models-config.plan.ts`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/models-config.plan.ts#L115-L120).
API-key providers use env-backed `apiKey` references. Codex OAuth uses the
native subscription route and the public provider-auth SDK with a namespaced
Clawdi-owned profile.

OAuth reconcile is durable and target-native:

- the credential revision is seed authority, not overwrite authority;
- refresh-token rotation performed by Hermes or OpenClaw is preserved;
- logout/revoke is recorded and is not silently replayed;
- write-ahead intent, compensation, ownership ledger, and compare-and-swap
  evidence guard every native mutation;
- one OAuth credential family cannot be owned by multiple Agent runtimes.

The last rule is a cross-runtime ownership fence. It is not a multi-provider
pool rule and remains required even though each runtime binds at most one
provider.

## Import And Export

Import existing metadata without activating a local runtime:

```bash
clawdi ai-provider import --from-hermes ~/.hermes/config.yaml
clawdi ai-provider import --from-openclaw ./openclaw-provider-config.json
clawdi ai-provider validate
```

Imports merge by default. Use `--replace` only when incoming IDs should replace
matching local records.

Default export contains metadata and secret references only:

```bash
clawdi ai-provider export --out ai-providers.json
clawdi ai-provider import ai-providers.json
```

Including env-backed secrets requires passphrase encryption:

```bash
export CLAWDI_SECRET_EXPORT_PASSPHRASE='choose-a-strong-passphrase'
clawdi ai-provider export \
  --out ai-providers-with-secrets.json \
  --include-secrets \
  --secret-passphrase
```

Do not commit decrypted or imported env files.

## Current Non-Goals

- Clawdi-proxied BYOK model requests.
- Local runtime activation/materialization from `clawdi ai-provider`.
- Claude Code OAuth through AI Provider.
- OAuth for Anthropic, Gemini, OpenRouter, Mistral, or arbitrary custom
  providers.
- Changing the public REST provider-array contract as part of Core Hosted
  binding admission.
