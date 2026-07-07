# OpenClaw v2 model projection investigation

Date: 2026-07-07

## Verdict

For v2 hosted runtime manifests that carry only the current single-model provider
contract (`baseUrl`, `model`, `apiMode`, `runtimeEnvName`, `apiKeySecretRef`),
the Clawdi CLI projects a bare OpenClaw model entry:

```json
{
  "id": "<manifest model>",
  "name": "<manifest model>",
  "api": "<OpenClaw api label, when non-default>"
}
```

For a non-built-in model slug that OpenClaw does not already know, the projected
OpenClaw `models.providers[].models[]` entry does **not** contain
`contextWindow` or `maxTokens`. Therefore v2 OpenClaw does not know the real
context window from Clawdi's projection. Any later context-window behavior is an
OpenClaw fallback for missing metadata, not a correct value supplied by Clawdi.

## CLI projection path

`clawdi ai-provider apply --target openclaw` enters
`buildAgentTargetProjection("openclaw", ...)` from
`packages/cli/src/commands/ai-provider-apply.ts:122` and wraps the generated JSON
as `openclaw config patch --stdin` at
`packages/cli/src/commands/ai-provider-apply.ts:278`.

The OpenClaw provider JSON is built in
`packages/cli/src/lib/ai-provider-projection.ts:256`. Each provider gets:

- `baseUrl`: from the normalized provider base URL
  (`packages/cli/src/lib/ai-provider-projection.ts:267`).
- `api`: OpenClaw API label mapped from provider `api_mode`
  (`packages/cli/src/lib/ai-provider-projection.ts:268`,
  `packages/cli/src/lib/ai-provider-projection.ts:347`).
- `apiKey`: env-secret reference when an agent env name exists
  (`packages/cli/src/lib/ai-provider-projection.ts:269`).
- `models`: from `openClawModels(...)`
  (`packages/cli/src/lib/ai-provider-projection.ts:272`).

`openClawModels(...)` maps catalog model metadata as follows
(`packages/cli/src/lib/ai-provider-projection.ts:313`):

| Catalog field | OpenClaw field |
| --- | --- |
| `id` | `id` |
| `label` | `name`, falling back to `id` |
| model/provider `api_mode` | `api`, unless default OpenAI chat |
| `input_modalities` | `input` |
| `context_window` | `contextWindow` |
| `max_tokens` | `maxTokens` |

It does not project `supports_reasoning`, `capabilities`, or `cost`
(`packages/cli/src/lib/ai-provider-projection.ts:320`). If the selected primary
model is not already in `provider.models`, it prepends only `{id, name, api}`
(`packages/cli/src/lib/ai-provider-projection.ts:335`).

The shared catalog type can store richer model metadata:
`input_modalities`, `supports_reasoning`, `context_window`, `max_tokens`, and
`cost` (`packages/shared/src/ai-provider.ts:48`). Validation accepts
`context_window` and `max_tokens` when numeric
(`packages/shared/src/ai-provider.ts:407`).

## v2 runtime init path

Hosted `runtime init` uses `hostedAiProviderCatalog(...)` to convert
`manifest.projection.providers` into the same AI-provider catalog type
(`packages/cli/src/runtime/manifest.ts:782`). Runtime scoping selects
`runtime.provider_ids`, a provider named after the runtime, or `default`
(`packages/cli/src/runtime/manifest.ts:830`).

The v2 manifest single-model value becomes catalog model metadata in
`hostedProviderModels(...)`. If `input.models` is missing, the code prepends:

```ts
{ id: legacyModel, api_mode: hostedProviderApiMode(input) }
```

from `input.model` (`packages/cli/src/runtime/manifest.ts:893`) and similarly
for runtime `primary_model` (`packages/cli/src/runtime/manifest.ts:897`). The
default API mode is `openai_chat` unless `apiMode`/`api_mode` is valid
(`packages/cli/src/runtime/manifest.ts:905`).

`runtime init` then calls the same OpenClaw projection builder and applies it
with:

```text
openclaw config patch --stdin --replace-path models.providers
```

(`packages/cli/src/runtime/manifest.ts:1095`). The v2 test fixture demonstrates
the contract shape: provider `openclaw` has `baseUrl`, `model`, `apiMode`,
`runtimeEnvName`, and `apiKeySecretRef` only
(`packages/cli/tests/runtime.test.ts:1161`). The asserted primary ref is
`openclaw/gpt-5.5` and the provider base URL is projected
(`packages/cli/tests/runtime.test.ts:1188`), but no test asserts
`contextWindow` or `maxTokens`.

## Field comparison

| Field in OpenClaw `models.providers[].models[]` | v1 legacy CLI apply | v1 bootstrap config | v2 single-model manifest projection |
| --- | --- | --- | --- |
| `id` | Present. From catalog model id; if the primary model is absent, a primary-only entry is prepended. | Present. Static model definitions include `id`. | Present. From manifest `model` or runtime `primary_model`. |
| `name` | Present. From catalog `label`, otherwise `id`. | Present for static Codex/Kimi definitions. | Present, but only as the model id because no `label` exists. |
| `api` | Present when mapped API mode is non-default, e.g. `openai-responses`; omitted for default OpenAI chat. | Provider-level API is present for Codex/Kimi providers; individual static models do not need per-model `api`. | Present when `apiMode` maps to non-default, e.g. `openai-responses`; otherwise absent. |
| `input` / input modalities | Present only if catalog model has `input_modalities`. | Present in static Codex/Kimi definitions as `input`. | Absent with the current single-model contract. |
| `contextWindow` | Present only if catalog model has numeric `context_window`. Preserved from existing OpenClaw config during apply when the same provider/model already exists (`packages/cli/src/commands/ai-provider-apply.ts:306`). | Present for static Codex and Kimi definitions (`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:77`). | Absent with the current single-model contract. |
| `maxTokens` / max output | Present only if catalog model has numeric `max_tokens`. | Present for static Codex and Kimi definitions as `maxTokens` (`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:86`). | Absent with the current single-model contract. |
| `reasoning` | Not projected from catalog `supports_reasoning`. | Present in static Codex/Kimi definitions as `reasoning` (`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:83`). | Absent. |
| `cost` | Not projected by the CLI. | Present in static Codex/Kimi definitions (`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:85`). | Absent. |
| provider `apiKey` | Present when env/runtime env auth is available. | Present as literal key or env secret ref depending migration gate. | Present as env secret ref derived from `runtimeEnvName`/`apiKeySecretRef`. |

## Hosted cross-reference

The v1/bootstrap hosted config path hardcodes rich Codex model definitions with
`reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens`
(`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:77`).
`build_openclaw_config(...)` includes those definitions under
`models.providers.openai-codex.models`
(`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:473`)
and Kimi definitions under `models.providers.kimi-coding.models`
(`/home/kingsley/clawdi-hosted/backend/app/services/openclaw_config.py:482`).

The v2 hosted runtime state payload carries runtime provider ids and primary
model refs (`/home/kingsley/clawdi-hosted/backend/app/v2/hosted/runtime_state.py:134`),
but not model capabilities. The managed AI provider metadata saved to cloud-api
also stores only `models: [{"id": default_model}]`
(`/home/kingsley/clawdi-hosted/backend/app/services/clawdi_cloud.py:221`).

The Sub2API metadata overlay has the desired upstream source. Production compose
sets:

```text
CODEX_MODELS_URL=https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json
```

(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/docker-compose.yml:166`).
The overlay code defines the same default URL
(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/metadata-overlay/internal/config/codex.go:12`),
requires `slug` and `context_window`, and maps Codex `context_window` to
metadata `ContextLength` and `MaxInputTokens`
(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/metadata-overlay/internal/config/codex.go:18`).
The README documents that it polls Codex `models.json` and maps
`context_window` to OpenAI-compatible `context_length` and `max_input_tokens`
(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/README.md:43`).
The bundled fallback config carries `max_output_tokens`
(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/metadata-overlay/config/models-metadata.yaml:2`),
and the overlay config schema validates that field
(`/home/kingsley/clawdi-hosted/infra/v2/sub2api/metadata-overlay/internal/config/config.go:16`).

## Recommendation

Add capability enrichment inside the CLI before `buildAgentTargetProjection(...)`
is called for hosted OpenClaw runtime projection. The smallest insertion point is
`hostedProviderModels(...)` in `packages/cli/src/runtime/manifest.ts:874`, or a
helper immediately after it, because that is where the v2 single `model` becomes
catalog model metadata. For `clawdi ai-provider apply`, the analogous source is
the local/remote AI provider catalog before `buildOpenClawProjection(...)`.

The enrichment should use the same upstream contract as the metadata overlay:
Codex `models.json` at the URL above. Map at least:

- `slug` -> catalog `id`
- `context_window` -> catalog `context_window`
- overlay fallback `max_output_tokens`, when available, -> catalog `max_tokens`

Then the existing OpenClaw projection will emit `contextWindow` and `maxTokens`
without changing OpenClaw's provider patch format. Extending the projection to
also map `supports_reasoning` -> `reasoning` and `cost` -> `cost` would close the
remaining v1 bootstrap/v2 gap, but requires an explicit catalog contract because
the current CLI projection does not emit those fields.
