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

For Hermes, Hosted convergence uses `hermes config get --json` when it needs a
resolved value, `unset` for deletion, and `set --force` for scalar writes. Raw
structured state is read from, and mappings and arrays are atomically
reconciled in, the YAML path reported by `hermes config path`, because `config
set` does not provide a portable structured-value contract across supported
installations. This preserves unrelated config and opaque map keys such as MCP
names containing dots. The projection maps portable API modes to Hermes
transport names and writes only environment-variable names for API-key
providers. Codex OAuth uses
Hermes' native `openai-codex` selector and a reserved Clawdi-owned
credential-pool entry. Managed API-key provider
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

The repository regression-audits these public SDK and projection mechanics with
`openclaw@2026.7.1-2`, official source commit
[`0790d9f`](https://github.com/openclaw/openclaw/commit/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c).
That artifact remains an API audit sample. The selected Clawdi release owns the
Hosted-v2 runtime pin `openclaw@2026.8.1-beta.2`; convergence also
capability-gates the APIs it uses.
The discovery skip is implemented in
[`models-config.plan.ts`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/models-config.plan.ts#L115-L120).
API-key providers use env-backed `apiKey` references and explicitly set
`auth: "api-key"`. This makes the provider entry win execution-time credential
selection, but it does not govern doctor migration. The precedence contract is
verified in OpenClaw's
[`model-auth-provider-config.ts`](https://github.com/openclaw/openclaw/blob/8f382a202ff1e15833394b481615dcdda99b04d7/src/agents/model-auth-provider-config.ts#L216-L226)
and
[`model-auth-provider.ts`](https://github.com/openclaw/openclaw/blob/8f382a202ff1e15833394b481615dcdda99b04d7/src/agents/model-auth-provider.ts#L310-L337).

`clawdi` is the reserved provider for the Hosted v2 managed projection, and its
environment SecretRef is the sole API-key authority. OpenClaw model generation
serializes the SecretRef id as the literal `CLAWDI_AI_API_KEY` marker in
`models.json`. Without provider metadata declaring that env name, OpenClaw
doctor treats the marker as credential material and allocates
`clawdi:default`. Doctor's collection and allocation are independent of
execution precedence in
[`doctor-model-catalog-credentials.ts`](https://github.com/openclaw/openclaw/blob/8f382a202ff1e15833394b481615dcdda99b04d7/src/commands/doctor-model-catalog-credentials.ts#L54-L76).
OpenClaw builds its known env markers from discovered plugin metadata through
[`provider-env-vars.ts`](https://github.com/openclaw/openclaw/blob/8f382a202ff1e15833394b481615dcdda99b04d7/src/secrets/provider-env-vars.ts#L198-L220),
and installed plugins may declare
`setup.providers: [{ id: "clawdi", envVars: ["CLAWDI_AI_API_KEY"] }]`. Hosted
v2 convergence materializes a credential-free, Clawdi-owned metadata plugin and
uses OpenClaw's official local plugin install/enable lifecycle before provider
projection or cleanup. It then verifies `CLAWDI_AI_API_KEY` through the public
`openclaw/plugin-sdk/provider-env-vars` export and fails closed if the marker is
not registered. Explicit `auth: "api-key"` remains necessary for execution
precedence but is not the doctor prevention mechanism. Commit `8f382a2` is
source provenance for this contract; the Clawdi release owns the exact Hosted-v2
artifact `openclaw@2026.8.1-beta.2`.

When the accepted Hosted v2 manifest proves that exact managed projection,
root-owned convergence uses OpenClaw's public config-mutation and provider-auth
SDKs to remove every normalized `clawdi` auth registration and stored profile.
The read-only preflight skips clean config/store writes. Transactional discovery
covers the default/main store, the active
`OPENCLAW_AGENT_DIR`, discovered state-tree agents, and explicitly configured
agent directories; related order, `lastGood`, and usage references are removed
by the owning APIs. Other providers, native Codex OAuth profiles, and unmanaged
mode are preserved. Codex OAuth continues to use the native subscription route
and a namespaced Clawdi-owned profile.

Existing Hosted v2 deployments receive this repair through the root-owned
runtime manifest converge path. After publishing the exact CLI package, Hosted
selects it and accepts a controlled rollout for each existing deployment. The
root-owned shim installs and verifies the package, atomically activates it, and
self-reexecs before manifest convergence; no runtime-image rebuild is required.
Changing the global package setting alone does not advance existing deployment
generations. Cleanup runs before gateway activation and does not depend on a
successful model response, a chat request, or OpenClaw doctor. A cleanup error
prevents applied-authority commit, so the deployment remains incomplete and
the next reconcile retries it.

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
