# AI Provider Agent Contract Audit

Date: 2026-07-27

This audit records source evidence for the verified contract baselines used by AI
Provider apply and auth flows. Historical package versions below are test
baselines, not installer pins, support ceilings, or future-version rejection
rules. AI Provider adapters must be updated only against verified agent source
or official docs.

## Summary

| Agent | Verified baseline evidence | AI Provider status | Config method |
| --- | --- | --- | --- |
| Codex | Official Codex manual profile contract plus historical package fixtures | Enabled | `$CODEX_HOME/clawdi-ai-provider.config.toml`, selected with `codex --profile clawdi-ai-provider` |
| Hermes | Historical package fixtures plus current providers-dict source contract | Enabled | Structured merge into `$HERMES_HOME/config.yaml` |
| OpenClaw | Historical package fixtures plus current config-patch/provider-auth SDK source contract | Enabled | `openclaw config patch --stdin` |
| Claude Code | No verified AI Provider contract baseline | Not supported | None |

## Codex

Verified sources:

- `codex-rs/utils/cli/src/shared_options.rs`: `--profile` loads a named profile.
- `codex-rs/config/src/loader/mod.rs`: profile files are loaded from
  `$CODEX_HOME/<name>.config.toml` on top of base user config.
- `codex-rs/core/config.schema.json`: supports `model_provider`,
  `model_providers`, `base_url`, `env_key`, `requires_openai_auth`, and
  `wire_api`.
- `codex-rs/login/src/server.rs`, `login/src/auth/manager.rs`, and
  `login/src/auth/default_client.rs`: OAuth client ID, scopes, loopback ports,
  originator, and token exchange are verified.
- `codex-rs/login/src/token_data.rs` and
  `codex-rs/app-server-protocol/src/protocol/common.rs`: `auth.json` accepts
  `auth_mode: "chatgpt"` and serializes `id_token` as the original JWT string.
- `@openai/codex@0.142.4` source audit on 2026-06-29 verified the same
  profile-v2 file path, `model_providers`, `wire_api`, `env_key`, and
  `requires_openai_auth` contract.

Clawdi behavior:

- `clawdi ai-provider apply <source>` writes
  `$CODEX_HOME/clawdi-ai-provider.config.toml`; it does not edit
  `$CODEX_HOME/config.toml`.
- The user launches Codex with `codex --profile clawdi-ai-provider`.
- API-key providers use `env_key`.
- Codex native OAuth providers use Codex's built-in OpenAI provider when the
  base URL is the default OpenAI URL, or `requires_openai_auth = true` for a
  custom provider entry.
- For the built-in OpenAI OAuth provider, Clawdi keeps the selected `model` and
  uses Codex's built-in `openai` model provider. This projection is independent
  of the Hermes provider path.
- Codex OAuth link generation is a backend responsibility. The CLI listens on
  `http://localhost:1455/auth/callback` and falls back to
  `http://localhost:1457/auth/callback`, or accepts a pasted redirect URL.
  The verified upstream OAuth constants are client ID
  `app_EMoamEEZ73f0CkXaXp7hrann`, scopes
  `openid profile email offline_access api.connectors.read api.connectors.invoke`,
  and originator `codex_cli_rs`.
- The historical fixtures cover `@openai/codex 0.134.0` through `0.142.4`.
  Runtime compatibility is determined by the required profile/config
  capabilities, not by treating that fixture range as a package allowlist.

## Hermes

Verified sources:

- `website/docs/integrations/providers.md`: `config.yaml` is the source of truth
  for model, provider, and base URL. Multiple custom providers use
  `custom_providers` list entries and `model.provider: custom:<name>`.
- `website/docs/user-guide/configuration.md` defines top-level `timezone` as an
  IANA timezone; `website/docs/guides/migrate-from-openclaw.md` maps OpenClaw
  `agents.defaults.userTimezone` directly to it.
- `hermes_cli/config.py`: current config supports a v12 `providers` dict,
  normalizes it into the legacy custom-provider view, and validates
  `custom_providers` as a list.
- `hermes_cli/runtime_provider.py`: named custom providers resolve from
  `providers` dict first, then `custom_providers`; entries support `api`/`url`/
  `base_url`, `key_env`, `default_model`, and `transport`/`api_mode`.
- `agent/credential_pool.py`: custom provider pool keys are derived from
  custom provider names, and the v12 `providers` dict flows through the
  compatibility layer.
- `hermes_cli/auth.py` in `hermes-agent==0.15.2` documents the historical
  singleton login at `providers.openai-codex.tokens`; the runtime also reads
  `credential_pool.openai-codex`. Current Clawdi convergence does not write
  that singleton. It writes only a reserved `clawdi:<provider-hash>` manual
  device-code entry in the native credential pool.
- `hermes-agent==0.17.0` package audit on 2026-06-29 verified the same
  `providers` dict compatibility layer, the current Hermes Responses transport,
  `openai-codex` provider selector, `active_provider`, and
  `credential_pool.openai-codex` runtime credential paths.
- The 2026-07-27 Docker smoke installed the PyPI
  `hermes-agent==0.18.2` wheel and invoked its real
  `resolve_runtime_provider()` for an env-backed Responses provider, Kimi
  Coding, and native `openai-codex`. The read-only source cross-check at
  `/home/kingsley/hermes-agent` commit
  `736fc4d86a1acd8c96473aeb55f9c783e2170dca` confirms the same keyed-provider
  resolution fields in `hermes_cli/config.py` and
  `hermes_cli/runtime_provider.py`.
- Docker package audits passed for `hermes-agent==0.13.0`, `0.14.0`,
  `0.15.0`, `0.15.1`, and `0.15.2`. Each package loaded a v12 `providers`
  dict from `config.yaml` and resolved `custom:openai-main` with Hermes'
  Responses transport and `key_env` auth.

Clawdi behavior:

- `clawdi ai-provider apply <source>` does a structured merge into
  `$HERMES_HOME/config.yaml`.
- The merge writes the verified v12 `providers` dict shape and sets
  `model.provider` to `custom:<provider-id>`.
- The same native `model`/`providers` authority is used when those capabilities
  are present. Hosted converge removes the obsolete Clawdi model-provider plugin so
  it cannot shadow a same-name keyed provider.
- Codex OAuth providers are projected through Hermes' native
  `model.provider: openai-codex` selector and Responses runtime, not as
  custom providers with `key_env`.
- For Codex OAuth sources, non-dry-run apply writes one deterministic
  `clawdi:<provider-hash>` entry under `credential_pool.openai-codex` with
  `source: manual:device_code`. It does not overwrite
  `providers.openai-codex`, the user's singleton, or other pool entries.
- Hermes refresh replaces only token fields on the selected pool entry and
  preserves its ID/source identity. Existing future numeric auth-store versions
  are preserved; unrecognized store shapes fail closed without rewrite.
- The merge preserves unrelated root sections such as `mcp_servers`.
- The merge removes stale direct model/provider secret fields for provider IDs
  managed by Clawdi so inline `api_key` values do not shadow `key_env`.
- Dry-run prints only the generated patch, not the existing `config.yaml`, to
  avoid leaking user inline secrets.
- Hosted user BYOK keys are resolved by the encrypted bootstrap/external-secret
  pipeline into runtime `secretEnv`; Clawdi-managed credentials use the
  separate deployment-scoped egress injection path. Hermes projection consumes
  only the resulting env names and does not read or require Vault.

Clawdi provider modes are standard API modes. The Hermes adapter translates
those modes into Hermes' target-native transport labels only at config output:

- `openai_chat` -> `chat_completions`
- `openai_responses` -> `codex_responses`
- `anthropic_messages` -> `anthropic_messages`

Not supported in Hermes AI Provider v1:

- `google_generate_content` direct projection. Hermes has a separate Gemini
  provider/plugin path; it is not the same as the generic custom-provider
  transport contract.
- `oauth_profile` auth and non-Codex `agent_profile` auth.

## OpenClaw

Verified sources:

- `docs/start/wizard-cli-reference.md`: env SecretRef examples use
  `{ source: "env", provider: "default", id: "OPENAI_API_KEY" }`.
- `docs/gateway/doctor.md`: canonical default model config uses
  `agents.defaults.model.primary`; provider config lives under
  `models.providers`.
- `dist/config-cli-*.js`: `openclaw config patch --stdin` is a native CLI
  command.
- `dist/types.secrets-*.js`: `isSecretRef` accepts `source`, `provider`, and
  `id`.
- `dist/models-auth-status-*.js`: `models.providers.<id>.apiKey` SecretRefs
  are recognized for configured-provider status.
- `src/plugin-sdk/provider-auth.ts`: the public
  `openclaw/plugin-sdk/provider-auth` package export exposes
  `ensureAuthProfileStoreForLocalUpdate` and
  `updateAuthProfileStoreWithLock` for database-first profile updates.
- Package smokes passed for `openclaw@2026.5.12`, `2026.5.18`,
  `2026.5.27`, and `2026.5.28` using `openclaw config patch --stdin
  --dry-run --json` with the AI Provider patch shape.
- `openclaw@2026.6.1` source audit verified the same config patch contract; the
  current baseline additionally verifies the public database-first
  provider-auth export above.
- `openclaw@2026.6.10` package audit on 2026-06-29 verified
  `openclaw config patch --stdin`, `models.providers`, `apiKey` SecretRefs,
  canonical `openai/<model>` native Codex routes, and direct
  `openai-responses` projection for OpenAI-compatible API-key providers.

Clawdi behavior:

- `clawdi ai-provider apply <source>` sends JSON patch content to
  `openclaw config patch --stdin`.
- The patch uses `models.mode: "merge"`, `models.providers.<id>.apiKey` env
  SecretRefs, and `agents.defaults.model.primary`.
- API-key projection has one model-provider authority under
  `models.providers`; the `secrets` block only declares the env SecretRef
  provider and cannot shadow a model provider. There is no Hermes-style
  generated provider plugin.
- OpenAI-compatible API-key providers project directly. `openai_chat` uses
  OpenClaw's default OpenAI-compatible chat surface; `openai_responses` writes
  `api: "openai-responses"` with the configured provider URL and env SecretRef.
  Clawdi does not expose a separate custom Codex Responses provider mode.
- Codex OAuth providers use OpenClaw's native OpenAI route:
  `plugins.entries.codex.enabled: true` and
  `agents.defaults.model.primary: openai/<model>`, without a
  `models.providers.<id>.apiKey` entry.
- For Codex OAuth sources, non-dry-run apply uses OpenClaw's public
  provider-auth package export to update the database-first auth profile store.
  It writes `openai:clawdi-<provider-hash>`, moves that profile to the front of
  `order.openai`, preserves all other unique order entries, and never touches
  `openai:default`.
- Hosted capability-probes that public export only when desired OAuth needs it.
  A missing export can trigger the official unversioned installer repair before
  any credential/config mutation; failure remains closed. Local apply reports
  the missing capability and never installs software.
- Model metadata omits unknown or zero values; Clawdi does not invent model
  cost/context defaults.
- Hosted OpenClaw receives resolved runtime env names. User BYOK bootstrap and
  Clawdi-managed deployment injection stay outside OpenClaw config, and neither
  projection path introduces a Vault dependency.
