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

The product has three provider kinds:

| Kind | User input | Model ownership |
| --- | --- | --- |
| Clawdi Managed | Choose a model when creating or editing an agent | Clawdi configures the connection and selected model |
| Custom provider | Name, Endpoint, API format, API key | The agent owns models and selection |
| Native provider | Choose a supported provider, Name, key/token or supported sign-in | The agent owns models and selection |

The provider chooser groups brands; a second step selects native region, plan,
or product variants before credential setup.
ChatGPT sign-in remains a native credential option. Every Name is only a Clawdi
`label`; renaming does not change stable IDs, credential identity, or runtime intent.
Provider credential forms have no model catalog editor or inference test.
Clawdi Managed retains its model picker on agent creation and settings pages. Credential environment names
are internal, unique at creation, and immutable on existing custom connections.

New Custom records use `configuration_mode: "custom"`. Create through the normal
atomic `/v1/ai-providers/accept` API with an API-key credential. No model metadata
is accepted or emitted. They support first binding, switching agents, and rebind
without a Clawdi-selected model. The provider remains the same saved connection;
native model choices remain local to each agent.

CLI initialization creates only a missing custom provider with routing and its env
credential reference. OpenClaw requires an empty `models` array for a new provider;
Hermes needs no model directory. This is not a guarantee that an arbitrary endpoint
supports discovery or that a model is already selected. Users choose models inside
the native agent. Subsequent convergence never seeds or replaces model fields.
A durable keyless pending-creation flag allows a retry after journal persistence
but before the first config write, and is cleared after successful authority commit.
After success, a user-deleted provider row is an error, not permission to restore it.

Custom edits use PATCH; an optional `credential: {type: "api_key", value: "..."}`
replaces the key atomically with label/routing changes. Models and auth/environment
identity cannot be replaced through PATCH or accept. Unbind removes only owned env
references and keeps routing, models and selection. Rebind restores its owned auth.
Hermes global model selection persists endpoint/protocol mirrors: matching mirrors
follow an explicit routing edit, while foreign routing/credentials fail preflight.
OpenClaw authentication-header overrides and personal Hermes pools cannot silently
replace the delivered key. No user credential is deleted to resolve a conflict.

The released `catalog` and migration-only `connection` modes remain internal
compatibility paths. They are not new provider choices. Existing records can use
"Manage models in agent", a mode-only PATCH to `custom`, preserving stored model
metadata and encrypted credentials. Bound consumers must first prove fresh current
source/apply identity on a qualified CLI. Unbound records may upgrade after the
feature release is enabled and initialize when subsequently bound. A bound runtime
with conflicting or missing native state still refuses unsafe handoff.

`supported_custom_provider_cli_versions` is an exact stable-release allowlist in
Core and the first-party control plane. It defaults closed. First-party admission
and provisioning require the server-selected exact CLI; Core also rejects runtime
state that would send Custom to an unsupported reader, and requires fresh consumed
evidence when adding a Custom binding to an existing instance. Enable only after
publishing and qualifying the supporting CLI. This is capability admission, not a
second desired-version selector. `supported_connection_cli_versions` continues to
protect the earlier migration-only contract. No allowlist is enabled by code.
Redacted include ownership remains excluded rather than guessed.

`native_provider` identifies the connection and `native_variant` optionally
identifies its region or plan. The shared
[`native-ai-providers.json`](../packages/shared/src/native-ai-providers.json) contains only
auth/routing metadata. Core validates the identity and hydrates endpoint,
protocol, and runtime credential delivery; Hosted consumes Core readiness.
The encrypted key or reference and the Agent binding remain separately owned.

Native connections include NVIDIA NIM, Fireworks AI, Hugging Face (access
token), DeepInfra, OpenCode Zen and Go, Xiaomi MiMo, and Tencent TokenHub and
TokenPlan, alongside the existing providers. OpenCode's per-model protocols,
provider request headers, and model catalogs remain native. TokenPlan uses
OpenAI chat in OpenClaw and Anthropic Messages in Hermes; runtime routing
overrides do not change the portable saved connection. Xiaomi Token Plan is
not included because the audited Hermes version has no separate native profile.

Omitted `configuration_mode` means the existing `catalog` contract. Existing
catalog connections keep their explicit model intent until the user converts
them. Custom endpoints retain URL/protocol and optional model metadata for
runtimes that require a fallback. Managed AI keeps frozen catalogs and an
explicit primary model.

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
Hosted controller admission (provider_ids length 0..2)
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

- configured mode contains one primary provider and may contain one additional
  capability provider;
- unmanaged mode contains an empty list;
- an explicit `primary_model.provider_id` must belong to the configured provider IDs;
- a native chat binding may omit `primary_model` or send null, including when
  accompanied by a separate managed embedding provider;
- the manifest `providers` projection must exactly match the selected IDs;
- the capability provider does not participate in chat fallback or ordering.

The public REST provider arrays and their existing limits are separate API
debt and are not the Hosted binding contract. Provider Catalog CRUD likewise
remains multi-record.

The bootstrap response is the only Hosted wire used for convergence. Provider
selection does not alter that stable contract.

Done: `bun test packages/cli/src/runtime/manifest-reconciliation.test.ts`
exits 0 and covers the optional capability provider plus duplicate and size
limits.

## Hosted Hermes And OpenClaw Delivery

Native credential convergence never writes `model.provider`/`model.default`
in Hermes or `agents.defaults.model.primary` in OpenClaw. This also applies to
Codex OAuth; its existing ownership and token-rotation reconciliation remains
in place. OpenClaw's current OAuth provider ID is `openai`, while Hermes uses
`openai-codex`; the portable credential identity stays `openai-codex`.

Native manifest entries are resolved directly to runtime connections. They do not
pass through the legacy catalog projector or synthesize a primary model.

OpenClaw enables the official provider plugin, installing it through the
native CLI when absent. Native capability consent and install policy remain
active. API keys use narrow `auth: "api-key"` and env SecretRef overrides so
an existing auth profile cannot silently replace the selected key. Native
provider objects contain no `models`; their catalog uses `models.mode: merge`.
Other provider settings and stored user auth profiles are preserved. Removing
a native binding removes its owned auth/endpoint fields, not the user profile.
These narrow updates use `openclaw config patch --stdin`; keys are supplied only
in the child process environment. Official CLI verification against npm
`openclaw@2026.9.2` ([`3928bad9`](https://github.com/openclaw/openclaw/tree/3928bad9badfcb6c7d140530435e806fb8092190))
confirmed merge and null deletion preserve unrelated fields. Its `--replace-path`
replaces a small catalog but rejects a 300-to-1 model reduction under the native
[size-drop guard](https://github.com/openclaw/openclaw/blob/3928bad9badfcb6c7d140530435e806fb8092190/src/config/io.write-safety.ts#L161).
The CLI has no explicit size-drop option, so owned catalog replacement and legacy
memory-layout repair retain the existing public SDK path, before native updates.

Hermes uses a namespaced native credential-pool entry and `fill_first` for the
bound API-key provider, preserving other pool entries and the selected model.
Key rotation updates only that entry. Its keyless ownership journal preserves
the prior credential strategy across retries and restores it when unbound.
Native pool APIs retain concurrent changes and cooldown state for other keys.
The standalone Python bridge calls public `read_credential_pool`,
`write_credential_pool`, `PooledCredential`, and `has_named_custom_provider`;
Bun embeds it in Node and native CLI builds. Secrets arrive through stdin.
Hermes `auth add` uses random IDs and a masked prompt or key argv, so it cannot
provide the required secure, owned, idempotent upsert. Its config CLI has no
batch/CAS operation; structured changes retain `HermesConfigTransaction`.
The installed Hermes auth resolver identifies aliases using the same provider
key as its credential pool (`opencode-zen`, not the models.dev alias `opencode`).
For the selected native provider, obsolete `model.base_url`, auth and protocol
overrides are removed through the config transaction; `model.provider` and
`model.default` are preserved. Connection overrides for other providers remain.

These native contracts are audited against OpenClaw
[`53ff0867`](https://github.com/openclaw/openclaw/tree/53ff0867149e1fd753cbfc9f67f79a28e6318f58/extensions)
and Hermes
[`96663732`](https://github.com/NousResearch/hermes-agent/blob/966637323e6f90864e069dbc12755934c2c86387/hermes_cli/runtime_provider.py).
Provider identity/auth mappings do not freeze upstream model catalogs.

Done: `scripts/test.sh cli src/runtime/native-provider-credentials.test.ts
src/runtime/hermes-native-credentials.test.ts` exits 0.

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

This provider catalog behavior is verified against Hermes `0.19.1`, source commit
[`cc4cab2f`](https://github.com/NousResearch/hermes-agent/tree/cc4cab2f592e60a197e796506de9168f74baf3ea):
[`model_switch.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/model_switch.py#L2613-L2658)
and its custom-provider path
[`model_switch.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/model_switch.py#L2791-L2942)
probe `/models` by default but honor `discover_models: false`;
[`config.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/hermes_cli/config.py#L1310-L1321)
accepts that provider field.

When the manifest selects an enabled Hermes runtime's Clawdi-managed Responses
provider (`managed_by: clawdi`), the CLI defaults
`HERMES_API_CALL_STALE_TIMEOUT=1200` in its generated gateway and dashboard
service environments. Explicit `run.env` / service `env` or `secretEnv` values
win. Hermes also gives explicit provider/model timeout config and the user's
`.hermes/.env` precedence. Generated run files and service environments retract
the default on a manifest switch to BYO, without editing user config or `.env`.
Provider names, gateway hostnames and merely running on hosted compute do not
identify Clawdi AI; no additional manifest policy field is needed.

The 1200-second scalar is the maximum native Codex context stale floor, not
dynamic equivalence. Hermes
[`9e6c4100` watchdogs](https://github.com/NousResearch/hermes-agent/blob/9e6c4100cbf5222fb473ecc2b51fd17874f6ee75/agent/chat_completion_helpers.py)
use 600/900/1200 seconds above 10k/50k/100k context tokens for native Codex.
The 1500-second native hard ceiling is not a stale baseline. The CLI leaves the
normal 1800-second request budget, Responses TTFB/event-idle settings, auth,
reasoning, retries, model capabilities and UI streaming defaults unchanged.
The user dotenv precedence is verified in
[`env_loader.py`](https://github.com/NousResearch/hermes-agent/blob/9e6c4100cbf5222fb473ecc2b51fd17874f6ee75/hermes_cli/env_loader.py#L349).

This default follows the manifest-selected deployment: a local/session-only
switch to another provider before authoritative manifest convergence shares
the service default for all models. Hermes collapses named custom profiles to
runtime provider `custom`; writing timeout-only `providers.custom` entries is
unsafe because its model-selection and provider metadata readers also consume
that namespace. The service environment avoids adding a bogus provider.

Done: `scripts/test.sh cli src/runtime/manifest-services.test.ts` verifies managed
selection, repeat convergence, explicit values and BYO withdrawal.

For explicit catalog connections, OpenClaw Hosted provider convergence uses the public
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
That artifact remains an API audit sample, not a Hosted install pin. Hosted v2
uses OpenClaw's official installer without a version argument; convergence
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
`models.json`. The supported `2026.7.1-2` and `2026.8.1` packages are exercised
with this native env-backed projection, including an explicit Doctor repair and
post-repair auth-store inspection. No provider metadata plugin participates in
the current contract. A historical beta workaround installed
`clawdi-managed-provider` only to register the env name as metadata; convergence
now removes a verified Clawdi-owned legacy installation with OpenClaw's official
uninstall command. An unrelated plugin with the same id is never removed.
Explicit `auth: "api-key"` remains necessary for execution precedence, and the
historical `clawdi` auth-profile cleanup remains in place for deployments that
were previously affected. `2026.7.1-2` may report the generated env marker as a
non-blocking `secrets audit` finding; Doctor and runtime authentication remain
functional.

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


## Recovering an already-applied custom provider

A failed desired provider change must not prevent restoring a custom provider
whose ownership was already transferred by a qualified CLI. Same-instance
runtime-state writes may recover only newly requested custom IDs found in the
unique authenticated applied observation for the persisted apply generation.
The active environment owner, deployment binding, instance, CLI selection,
receipt/boot identity and source/ETag pair must match. Multiple boots (even
expired ones), missing observations, retired bindings and changed incarnations
fail closed. The ordinary runtime-state generation and owner locks still apply.

Historical error/expired observations establish previous ownership, never health
or current convergence. When the current source exists it must match the applied
source. When rendering fails, the persisted failure must belong to the current
renderer contract. A historical claim cannot admit an unrelated custom provider;
new handoffs retain the fresh, healthy, exact-source CLI requirement.

The CLI still creates a missing provider only on initialization when it has no
previous ownership record or a pending creation. A completed ownership record
never authorizes recreating a missing provider. Recovery preserves native models
and user configuration; it does not explain who removed a provider.

Done: `bash scripts/test.sh backend tests/test_ai_provider_connection_ownership.py`
passes against the runner's isolated PostgreSQL. No CLI or wire-schema change is
required.
