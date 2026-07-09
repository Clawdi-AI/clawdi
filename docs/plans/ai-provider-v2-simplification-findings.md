# AI Provider V2 Simplification Findings

## Scope

This note records the runtime-facing evidence behind the hosted v2 AI Provider
simplification. It focuses on the fields the agent runtimes actually consume,
not the legacy dashboard form shape.

## Runtime evidence

- The hosted dashboard bootstrap forwards provider metadata almost verbatim into
  the runtime catalog: `provider_id`, `type`, `base_url`, `auth`,
  `managed_by`, `models`, `api_mode`, and `runtime_env_name`
  (`apps/web/src/hosted/v2/ai-providers/runtime-bootstrap.ts:39-81`).
- The Clawdi CLI projection is the authoritative apply path. It rejects
  providers that lack a usable auth env name or `api_mode`, preserves
  `base_url`, `auth`, `managed_by`, `models`, and `runtime_env_name`, and picks
  the primary model from the provider catalog/defaults
  (`packages/cli/src/lib/ai-provider-projection.ts:175-255`).
- OpenClaw projection consumes `baseUrl`, `api`, API-key env wiring, and
  provider/model catalogs; Codex OAuth is a special native OpenAI path
  (`packages/cli/src/lib/ai-provider-projection.ts:258-392`).
- Hermes projection consumes `provider`, `base_url`, `transport`, optional
  `key_env`, and model metadata; native Codex OAuth is a distinct
  `openai-codex` path (`packages/cli/src/lib/ai-provider-projection.ts:398-520`).
- Codex projection consumes Responses-compatible `base_url`, optional `env_key`,
  and the primary model; native Codex auth projects to built-in OpenAI auth
  instead of a custom provider block
  (`packages/cli/src/lib/ai-provider-projection.ts:523-570`).
- The managed transparent-gateway path is gated by `managed_by === "clawdi"`
  plus `baseUrl`, `apiMode`, and a secret ref; user BYOK providers do not go
  through that MITM profile path
  (`packages/cli/src/runtime/hosted-mitm-profiles.ts:124-197`).

## Upstream contract checks

- OpenClaw documents custom-provider consumption via
  `models.providers.*.{api,apiKey,baseUrl,models}`
  (`/home/kingsley/openclaw/docs/gateway/config-tools.md:455-519`) and merge
  precedence for `baseUrl`/`apiKey`/catalog refresh
  (`/home/kingsley/openclaw/docs/concepts/models.md:343-354`).
- OpenClaw documents that `openai/<model>` plus an `openai-codex` auth profile
  is the Codex-auth runtime path
  (`/home/kingsley/openclaw/docs/concepts/agent-runtimes.md:92-105`).
- Hermes defines a native `openai-codex` overlay with
  `transport="codex_responses"` and
  `base_url_override="https://chatgpt.com/backend-api/codex"`
  (`/home/kingsley/.hermes/hermes-agent/hermes_cli/providers.py:62-71`).
- Hermes determines effective API mode from provider/base URL heuristics and
  reads user-config providers from `api|url|base_url`, `key_env`, and
  `transport`
  (`/home/kingsley/.hermes/hermes-agent/hermes_cli/providers.py:533-613`).
- Hermes model switching carries user-config `base_url`, `key_env`, and
  resolved `api_mode` into runtime provider resolution
  (`/home/kingsley/.hermes/hermes-agent/hermes_cli/model_switch.py:1168-1199`).
- Hermes runtime swaps `api_key` and `base_url` directly on the OpenAI client
  and re-applies URL-specific headers
  (`/home/kingsley/.hermes/hermes-agent/run_agent.py:4386-4505`).
- Hermes detects the Codex backend from `api_mode == "codex_responses"` plus
  the ChatGPT Codex URL/provider shape
  (`/home/kingsley/.hermes/hermes-agent/run_agent.py:1290-1317`).
- Hermes loads stored `openai-codex` OAuth credentials from its auth store and
  rehydrates them into the credential pool
  (`/home/kingsley/.hermes/hermes-agent/agent/credential_pool.py:2028-2060`).

## What is essential vs derivable

- Essential runtime inputs:
  - `base_url`
  - `api_mode`
  - auth path: `auth` plus either `runtime_env_name`/`env:` ref for BYOK, or
    native Codex auth metadata for OAuth
  - `models`, because the projection chooses the primary/default model from the
    catalog and emits provider model metadata
- System-owned but runtime-significant:
  - `managed_by`, because the hosted managed gateway path keys off it
    (`packages/cli/src/runtime/hosted-mitm-profiles.ts:144-197`)
- Fully derivable from a provider-type catalog for known providers:
  - default `base_url`
  - default `api_mode`
  - default `runtime_env_name`
  - default model catalog / first model
  - the Codex OAuth model catalog for ChatGPT sign-in

## Product implication

- Known providers can be reduced to provider choice plus credential input.
- ChatGPT/Codex OAuth should never ask for a typed model catalog; the runtime
  already expects a known OpenAI/Codex path.
- Only a genuine custom OpenAI-compatible endpoint needs advanced fields
  (`base_url`, `api_mode`, `runtime_env_name`, `models`).
