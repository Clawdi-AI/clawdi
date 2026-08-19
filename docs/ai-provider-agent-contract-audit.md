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
from supervised service `companions`. Canonical `terminalTooling.codex` carries
the Clawdi provider endpoint but no provider model catalog. The new CLI writes
no Codex `model`, `models`, or `model_catalog_json`; it writes only
`model_provider` and the custom provider's name, endpoint, canonical env key,
and Responses transport.

The remaining fixed terminal fields are intentionally repeated under
`clawdi.hosted-runtime.manifest.v1`. The running CLI strictly parses that shape
before it can install and re-exec `clawdiCli.packageSpec`, so removing a v1
required field would prevent an older CLI from reaching its upgrade. The CLI
therefore validates but ignores the compatibility-only v1 `primary_model`. It
also accepts legacy terminal-Codex `OPENAI_API_KEY` and provider `models` on
read, strips the latter, and always writes `CLAWDI_AI_API_KEY` locally. Runtime
provider and BYOK schemas do not receive this compatibility allowance.

The Hosted bootstrap uses audited `@openai/codex` `0.146.0` only when Codex is
missing or damaged. A healthy tenant-owned install is not pinned or rolled
back. In the bootstrap version,
[`ModelProviderInfo`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider-info/src/lib.rs#L86-L144)
defaults `name` to the empty display value and `wire_api` to `responses`, but
[`validate_model_providers`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/config_toml.rs#L924-L946)
rejects an empty custom-provider name. Generated Hosted `config.toml` therefore
includes an explicit display name and `wire_api = "responses"` alongside the
custom provider selection, Clawdi `base_url`, and `env_key`. The official
[custom-provider documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
confirms that `env_key` names a provider-chosen variable.

Without `model_catalog_json`, the configured provider constructs
[`OpenAiModelsManager`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider/src/provider.rs#L328-L348),
which initializes from bundled `models.json`. Its
[`should_refresh_models`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/models-manager/src/manager.rs#L414-L416)
gate requires Codex-backend auth or `auth.command`; a plain `env_key` does not
qualify. On the normal Clawdi-provisioned path, a fresh managed home has neither
command auth nor Codex-backend auth, so Codex does not remotely refresh and
selects its default from the bundled catalog. However,
[`ThreadManager`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/thread_manager.rs#L300-L308)
passes its global `AuthManager` to the custom provider, and providers without
command auth
[`retain it`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider/src/auth.rs#L166-L176).
A manually written or stale ChatGPT backend auth file can therefore satisfy the
endpoint's
[`uses_codex_backend`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/model-provider/src/models_endpoint.rs#L68-L72)
gate. Codex exposes no OpenClaw/Hermes-style discovery-off setting, and Clawdi
does not invent one. In the bootstrap catalog,
[`gpt-5.6-sol`](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/models-manager/models.json#L3-L11)
is the first picker-visible model after
[`priority` sorting](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/models-manager/src/manager.rs#L122-L134),
so it is the current upstream-owned default. Clawdi does not encode that model
choice.

Deployment is two-stage. Phase A publishes the dual-read/canonical-write
`clawdi@0.13.69`; the backend continues to emit legacy `OPENAI_API_KEY`. Phase B
is a separate backend change gated on the exact CLI being published, desired
package specs advancing, and `activeCliVersion` proving that the current running
CLI is that exact version. Installed CLI diagnostics are not execution authority.
The current flow parses the strict manifest before `applyRuntimeCliDesiredState`,
so enabling canonical backend emission earlier would strand an older CLI before
self-upgrade.

## Hermes

Verified upstream behavior:

- `config.yaml` is the authority for model, provider, base URL, and transport.
- Current Hermes accepts a keyed `providers` dictionary and resolves named
  custom providers through that dictionary.
- Managed API-key provider rows set the real per-provider
  `discover_models: false` field and use the explicit accepted-generation
  `models` mapping. Hermes otherwise probes `/models`; it has no global
  OpenClaw `models.mode=replace` equivalent.
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
- replaces every generated provider field on each generation so stale models
  are removed;
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
- `models.mode = "replace"` skips implicit provider discovery;
- the config-patch interface accepts JSON from standard input;
- provider API keys may use native environment SecretRefs; and
- configured `auth.profiles` and `auth.order` participate directly in profile
  selection; and
- `openclaw/plugin-sdk/provider-auth` exposes the database-first locked update
  boundary used for auth profiles.

OpenClaw doctor scans generated model catalogs independently of provider
execution precedence. A historical Clawdi projection serialized the literal
SecretRef marker `CLAWDI_AI_API_KEY` into `models.json`; doctor did not
recognize it as non-secret and persisted it as the first `clawdi:default`
API-key profile. OpenClaw reads known env markers from installed plugin setup
metadata. Hosted v2 therefore installs and enables a credential-free,
Clawdi-owned metadata plugin declaring
`setup.providers: [{ id: "clawdi", envVars: ["CLAWDI_AI_API_KEY"] }]` before
provider projection and cleanup. Convergence verifies the effective marker via
the public provider-env-vars SDK and fails closed if OpenClaw did not register
it. This contract does not depend on a legacy plugin. The audited `8f382a2`
source is provenance evidence, while the selected Clawdi release owns the
Hosted-v2 exact package pin `openclaw@2026.8.1-beta.2` behind the unchanged
official-installer selector.

Hosted v2 convergence:

- sends a target-native provider patch instead of editing OpenClaw config
  files directly;
- projects API-key providers with explicit `auth: "api-key"` ownership and
  environment-backed `apiKey` references;
- treats the managed `clawdi` provider as reserved and its environment
  SecretRef as the only API-key authority;
- installs and verifies the credential-free provider metadata before writing
  the generated model catalog, preventing doctor from treating the SecretRef
  marker as credential material;
- only when the accepted v2 bundle proves that managed projection, atomically
  removes normalized `clawdi` config auth profiles/order and uses the public
  provider-auth helper to remove normalized `clawdi` stored profiles plus
  order, `lastGood`, and usage state;
- covers the default/main auth store, the active agent store, state-tree agent
  stores, and explicitly configured agent directories in the same rollback
  snapshot; clean preflight results do not write config or auth stores;
- runs inside root-owned runtime manifest convergence before gateway
  activation, independently of doctor and model/chat health; cleanup failure
  blocks authority commit and remains retryable on the next reconcile;
- uses the native OpenAI subscription route for Codex OAuth;
- owns only a namespaced `openai:clawdi-<provider-hash>` profile;
- preserves all non-`clawdi` config, profiles, order entries, and native Codex
  OAuth state, and does nothing in unmanaged mode; and
- fails closed before cleanup when either public config-mutation or
  provider-auth boundary is unavailable.

Hosted v2 rollout is a separate delivery requirement: publish the exact CLI
package, select it in Hosted, and accept a controlled rollout for each existing
deployment. The root-owned shim installs and verifies that package, atomically
activates it, and self-reexecs before manifest convergence. This repair does
not require a runtime-image rebuild, but changing the global CLI setting alone
does not advance an existing deployment generation.

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
