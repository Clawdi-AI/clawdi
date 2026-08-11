# Hosted AI Provider Native Contract Audit

This audit records the current native contracts used by Core Hosted runtime
convergence. It does not describe a local Provider activation workflow.

## Scope

Core stores a multi-record Provider Catalog, while each configured Hosted
Hermes or OpenClaw runtime binds exactly one provider. The controller emits the
stable bootstrap and Hosted desired-state bundle; the CLI runtime reconciler
projects that single selection into the target-native configuration and
credential store.

Provider requests continue to flow directly from the runtime to the selected
provider. Core does not proxy user BYOK model traffic.

## Codex OAuth Credential Source

Codex OAuth is the verified OAuth credential source for Hosted Hermes and
OpenClaw bindings. The backend owns authorization, token exchange, encrypted
payload persistence, replay fencing, compensation, durable revoke, terminal
scrubbing, and retention.

The native token contract is based on the official Codex OAuth flow and
`auth.json` token shape. Runtime convergence treats the backend credential
revision as seed authority, not overwrite authority: target-native refresh
rotation is preserved, and a logout or revoke is not silently recreated.

One credential family may be owned by only one Agent runtime. This is an
ownership fence across runtimes, not a multi-provider pool feature.

## Hosted Terminal Codex

Hosted Codex remains terminal tooling, separate from runtime providers and
from supervised service `companions`. Its dynamic consumer inputs are the
selected model and Clawdi provider endpoint. Cloud therefore omits the
provider model catalog from `terminalTooling.codex`; OpenClaw and Hermes runtime
providers still receive their complete model metadata and opaque `compat`
facts.

The remaining fixed terminal fields are intentionally repeated under
`clawdi.hosted-runtime.manifest.v1`. The running CLI strictly parses that shape
before it can install and re-exec `clawdiCli.packageSpec`, so removing a v1
required field would prevent an older CLI from reaching its upgrade. The CLI
validates those invariants, then derives its local provider id, Responses
transport, API-key environment name, and secret ownership contract.

The dedicated Hosted install pins `@openai/codex` `0.146.0`. In that version,
[`ModelProviderInfo`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider-info/src/lib.rs#L86-L144)
defaults `name` to the empty display value and `wire_api` to `responses`, but
[`validate_model_providers`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/config_toml.rs#L924-L946)
rejects an empty custom-provider name. Generated Hosted `config.toml` therefore
includes an explicit display name and `wire_api = "responses"` alongside the
selected model, custom provider selection, Clawdi `base_url`, and `env_key`.

## Hermes

Verified upstream behavior:

- `config.yaml` is the authority for model, provider, base URL, and transport.
- Current Hermes accepts a keyed `providers` dictionary and resolves named
  custom providers through that dictionary.
- The native `openai-codex` provider reads namespaced entries from
  `credential_pool.openai-codex`.
- The native provider owns its Responses transport and endpoint: the supported
  source registers
  [`base_url="https://chatgpt.com/backend-api/codex"`](https://github.com/NousResearch/hermes-agent/blob/9eec86923c777f5c26092c0b3e0f657ca18f2d98/plugins/model-providers/openai-codex/__init__.py#L6-L13),
  and runtime resolution falls back to that registered default. A Clawdi
  `model.base_url` override would only duplicate upstream configuration.
- Native credential mutation is serialized by Hermes' `auth.lock` protocol.

Core Hosted convergence:

- performs a structured merge and preserves unrelated configuration;
- maps portable API modes to Hermes transport names;
- writes environment-variable names, never API-key values, into provider
  configuration;
- selects Hermes' native `openai-codex` path for Codex OAuth;
- owns only its reserved `clawdi:<provider-hash>` credential-pool entry; and
- preserves target-native refreshes and unrelated pool entries.

Unknown credential-pool items, duplicate reserved IDs, or an unsupported store
shape fail closed without rewriting the file. On Windows, mutation is rejected
when Core cannot acquire Hermes' official compatible lock.

## OpenClaw

Verified upstream behavior:

- provider configuration lives under `models.providers` and the selected model
  under `agents.defaults.model.primary`;
- the config-patch interface accepts JSON from standard input;
- provider API keys may use native environment SecretRefs; and
- `openclaw/plugin-sdk/provider-auth` exposes the database-first locked update
  boundary used for OAuth profiles.

Core Hosted convergence:

- sends a target-native provider patch instead of editing OpenClaw config
  files directly;
- projects API-key providers with environment-backed `apiKey` references;
- uses the native OpenAI subscription route for Codex OAuth;
- owns only a namespaced `openai:clawdi-<provider-hash>` profile;
- preserves unrelated profiles and order entries; and
- fails closed before configuration or credential mutation when the public
  provider-auth boundary is unavailable.

## Shared Safety Boundaries

- Hosted endpoints must pass the shared public-HTTPS shape validator before
  credential selection or decryption.
- Provider auth transition cannot revive stale encrypted material.
- Native mutation uses write-ahead intent and before/target digest or
  compare-and-swap evidence.
- Unresolved intent remains unresolved; material presence alone never proves
  ownership.
- Dry planning inside Hosted convergence does not claim credentials or mutate
  native stores.

Maintained tests live in `backend/tests/test_ai_providers.py`,
`backend/tests/test_ai_provider_oauth_revoke_worker.py`,
`packages/cli/src/lib/codex-oauth-native-store.test.ts`, and
`packages/cli/tests/runtime.test.ts`.
