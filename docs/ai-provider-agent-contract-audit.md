# AI Provider Agent Contract Audit

Date: 2026-06-29

This audit pins the agent configuration contracts used by AI Provider apply and
auth flows. AI Provider adapters must be updated only against verified agent
source or official docs.

## Summary

| Agent | Verified version/source | AI Provider status | Config method |
| --- | --- | --- | --- |
| Codex | `@openai/codex@0.134.0` through `0.142.4`; official Codex manual profile contract | Enabled | `$CODEX_HOME/clawdi-ai-provider.config.toml`, selected with `codex --profile clawdi-ai-provider` |
| Hermes | `hermes-agent==0.13.0` through `0.17.0` package audit | Enabled | Structured merge into `$HERMES_HOME/config.yaml` |
| OpenClaw | `openclaw@2026.5.12` through `2026.6.10` package/source audit | Enabled | `openclaw config patch --stdin` |
| Claude Code | Not pinned for AI Provider v1 | Not supported | None |

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
  originator, and token exchange are pinned.
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
- For the built-in OpenAI OAuth provider, Clawdi omits `model` from the
  generated profile so Codex selects the default model supported by the
  signed-in ChatGPT/Codex account.
- Codex OAuth link generation is a backend responsibility. The CLI listens on
  `http://localhost:1455/auth/callback` and falls back to
  `http://localhost:1457/auth/callback`, or accepts a pasted redirect URL.
  The pinned upstream OAuth constants are client ID
  `app_EMoamEEZ73f0CkXaXp7hrann`, scopes
  `openid profile email offline_access api.connectors.read api.connectors.invoke`,
  and originator `codex_cli_rs`.
- The verified range is `@openai/codex 0.134.0` through `0.142.4`.
  Versions before `0.134.0` use older profile semantics and are not supported
  by AI Provider apply. Newer versions should be re-audited before broadening
  this range.

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
- `hermes_cli/auth.py` in `hermes-agent==0.15.2`: `openai-codex` credentials
  are stored in `$HERMES_HOME/auth.json` under
  `providers.openai-codex.tokens`; the runtime also reads
  `credential_pool.openai-codex`.
- `hermes-agent==0.17.0` package audit on 2026-06-29 verified the same
  `providers` dict compatibility layer, the current Hermes Responses transport,
  `openai-codex` provider selector, `active_provider`, and
  `credential_pool.openai-codex` runtime credential paths.
- Docker package audits passed for `hermes-agent==0.13.0`, `0.14.0`,
  `0.15.0`, `0.15.1`, and `0.15.2`. Each package loaded a v12 `providers`
  dict from `config.yaml` and resolved `custom:openai-main` with Hermes'
  Responses transport and `key_env` auth.

Clawdi behavior:

- `clawdi ai-provider apply <source>` does a structured merge into
  `$HERMES_HOME/config.yaml`.
- The merge writes the verified v12 `providers` dict shape and sets
  `model.provider` to `custom:<provider-id>`.
- Codex OAuth providers are projected through Hermes' native
  `model.provider: openai-codex` selector and Responses runtime, not as
  custom providers with `key_env`.
- For Codex OAuth sources, non-dry-run apply writes Hermes' native
  `$HERMES_HOME/auth.json` with `providers.openai-codex.tokens`,
  `active_provider: openai-codex`, and a matching
  `credential_pool.openai-codex` `device_code` entry.
- The merge preserves unrelated root sections such as `mcp_servers`.
- The merge removes stale direct model/provider secret fields for provider IDs
  managed by Clawdi so inline `api_key` values do not shadow `key_env`.
- Dry-run prints only the generated patch, not the existing `config.yaml`, to
  avoid leaking user inline secrets.

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
- `docs/start/wizard-cli-reference.md` and `docs/help/faq-models.md`: model
  auth profiles live at
  `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- `dist/store-*.js`: canonical auth profile stores use
  `{ version: 1, profiles: { ... } }`; OAuth credentials use
  `type: "oauth"`, `provider`, `access`, `refresh`, `expires`, and optional
  identity fields.
- Package smokes passed for `openclaw@2026.5.12`, `2026.5.18`,
  `2026.5.27`, and `2026.5.28` using `openclaw config patch --stdin
  --dry-run --json` with the AI Provider patch shape.
- `openclaw@2026.6.1` source audit verified the same config patch contract and
  the canonical `openai:<profile>` auth profile store under the active agent's
  `auth-profiles.json`.
- `openclaw@2026.6.10` package audit on 2026-06-29 verified
  `openclaw config patch --stdin`, `models.providers`, `apiKey` SecretRefs,
  canonical `openai/<model>` native Codex routes, and direct
  `openai-responses` projection for OpenAI-compatible API-key providers.

Clawdi behavior:

- `clawdi ai-provider apply <source>` sends JSON patch content to
  `openclaw config patch --stdin`.
- The patch uses `models.mode: "merge"`, `models.providers.<id>.apiKey` env
  SecretRefs, and `agents.defaults.model.primary`.
- OpenAI-compatible API-key providers project directly. `openai_chat` uses
  OpenClaw's default OpenAI-compatible chat surface; `openai_responses` writes
  `api: "openai-responses"` with the configured provider URL and env SecretRef.
  Clawdi does not expose a separate custom Codex Responses provider mode.
- Codex OAuth providers use OpenClaw's native OpenAI route:
  `plugins.entries.codex.enabled: true` and
  `agents.defaults.model.primary: openai/<model>`, without a
  `models.providers.<id>.apiKey` entry.
- For Codex OAuth sources, non-dry-run apply writes the active OpenClaw agent's
  `auth-profiles.json` with an `openai:<profile>` OAuth profile and
  `order.openai` pointing at that profile.
- Model metadata omits unknown or zero values; Clawdi does not invent model
  cost/context defaults.
