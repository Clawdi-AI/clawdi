# OpenClaw and Hermes model capability field investigation

Date: 2026-07-07

Source snapshots:

- OpenClaw: `/tmp/openclaw-cap`, commit `e72dadbb3bb1`
- Hermes: `/tmp/hermes-cap`, commit `536ffedbf470`

This investigation used fresh official upstream clones, not Clawdi forks.

## Verdict

The earlier conclusion that these fields are all dead data is too broad.
OpenClaw and Hermes both consume model capability metadata, but they do not
consume the same field names or shapes.

- OpenClaw consumes `contextWindow`, `maxTokens`, `input`, `reasoning`, and
  `compat.supportsTools`.
- Hermes consumes `context_length`, `max_tokens` / provider
  `max_output_tokens`, and `supports_vision`.
- Hermes does not use user/project per-model `supports_tools` or
  `supports_reasoning` as runtime gates.
- Neither agent uses `max_input_tokens` as the LLM runtime budget field.

For a canonical Clawdi v2 managed-provider schema, the fields worth carrying are:

```ts
{
  id: string;
  context_window?: number;
  max_tokens?: number; // output cap; keep current name unless doing a migration
  input_modalities?: Array<"text" | "image" | "video" | "audio">;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
}
```

Do not add `max_input_tokens` for agent projection. It is redundant with the
context window for these consumers. Do not add a separate `max_output_tokens`
unless we intentionally migrate from the current `max_tokens` catalog field; for
agent projection, `max_tokens` already means output cap and maps to the right
agent-specific names.

## Field Matrix

| Candidate field | OpenClaw reads and acts? | Hermes reads and acts? | Projection verdict |
| --- | --- | --- | --- |
| `context_window` | Yes, if mapped to `contextWindow`. The OpenClaw model schema has `contextWindow` (`/tmp/openclaw-cap/src/config/types.models.ts:185`) and configured per-model entries are read from `models.providers.<id>.models[]` for context budgeting (`/tmp/openclaw-cap/src/agents/context-resolution.ts:106`, `/tmp/openclaw-cap/src/agents/context-resolution.ts:115`, `/tmp/openclaw-cap/src/agents/context-resolution.ts:118`). Missing configured model values default to `128000` in the registry (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:559`) or can hit runtime fixed/fallback behavior (`/tmp/openclaw-cap/src/agents/context-resolution.ts:240`). | Yes, but Hermes wants `context_length`, not `context_window`, in config. Agent init reads `model.context_length` (`/tmp/hermes-cap/agent/agent_init.py:1620`) and custom provider per-model `context_length` (`/tmp/hermes-cap/agent/agent_init.py:1658`). `get_model_context_length` gives explicit config first priority (`/tmp/hermes-cap/agent/model_metadata.py:1886`, `/tmp/hermes-cap/agent/model_metadata.py:1896`). | Useful. Keep canonical `context_window`, but map per target: OpenClaw `contextWindow`; Hermes `context_length`. |
| `max_tokens` | Yes, if mapped to `maxTokens`. The OpenClaw schema has `maxTokens` as completion/output budget (`/tmp/openclaw-cap/src/config/types.models.ts:193`), defaults missing values to `16384` (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:560`), sends it as Responses `max_output_tokens` (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:2380`), and uses it for Completions max-token resolution (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:4383`). | Yes as runtime output cap, but through `model.max_tokens` or provider-level fallback, not a models.dev-style arbitrary capability. Gateway reads top-level `model.max_tokens` (`/tmp/hermes-cap/gateway/run.py:1846`) and falls back to runtime `max_output_tokens` (`/tmp/hermes-cap/gateway/run.py:1850`). Chat completions forwards `agent.max_tokens` (`/tmp/hermes-cap/agent/chat_completion_helpers.py:846`) and transport resolves the outgoing max-token param (`/tmp/hermes-cap/agent/transports/chat_completions.py:508`). | Useful. Keep current canonical `max_tokens` as output cap; map to OpenClaw `maxTokens`, Hermes `model.max_tokens` or provider `max_output_tokens` as appropriate. |
| `input_modalities` | Yes, if mapped to OpenClaw `input`. The schema stores supported input modalities (`/tmp/openclaw-cap/src/config/types.models.ts:164`), accepts text/image in the registry schema (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:165`), defaults to `["text"]` when absent (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:557`), and checks `model.input.includes("image")` for native image handling (`/tmp/openclaw-cap/src/agents/embedded-agent-runner/run/images.ts:539`, `/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:1193`, `/tmp/openclaw-cap/src/media-understanding/image.ts:198`). | Not as a config override. Hermes parses input modalities from models.dev metadata (`/tmp/hermes-cap/agent/models_dev.py:620`) and derives `supports_vision` from that metadata, but the user/project config override is `supports_vision`, not `input_modalities`. | Useful for OpenClaw. For Hermes, derive/project `supports_vision` from `input_modalities` when `image` is present. |
| `supports_vision` | Not as a field. OpenClaw has no `supports_vision` / `supportsVision` model-config slot in `ModelDefinitionConfig`; vision is represented by `input` (`/tmp/openclaw-cap/src/config/types.models.ts:153`, `/tmp/openclaw-cap/src/config/types.models.ts:164`). | Yes. Hermes explicitly checks top-level `model.supports_vision` first (`/tmp/hermes-cap/agent/image_routing.py:202`), then `providers.<provider>.models.<model>.supports_vision` (`/tmp/hermes-cap/agent/image_routing.py:222`, `/tmp/hermes-cap/agent/image_routing.py:229`), then models.dev (`/tmp/hermes-cap/agent/image_routing.py:373`, `/tmp/hermes-cap/agent/image_routing.py:384`, `/tmp/hermes-cap/agent/image_routing.py:396`). Runtime message/image routing calls `_model_supports_vision()` (`/tmp/hermes-cap/run_agent.py:4872`, `/tmp/hermes-cap/run_agent.py:4892`) and strips or preserves image parts based on it (`/tmp/hermes-cap/run_agent.py:4988`, `/tmp/hermes-cap/run_agent.py:5018`, `/tmp/hermes-cap/run_agent.py:5051`). Missing config can misclassify custom/local vision models as non-vision (`/tmp/hermes-cap/run_agent.py:4883`). | Useful. Add to canonical schema if Hermes is a target. For OpenClaw, map this to `input: ["text", "image"]` or derive it from `input_modalities`; do not emit raw `supports_vision`. |
| `supports_tools` | Yes only if mapped to `compat.supportsTools`. OpenClaw's compat schema has `supportsTools` (`/tmp/openclaw-cap/src/config/types.models.ts:81`, `/tmp/openclaw-cap/src/config/types.models.ts:93`). `supportsModelTools` defaults absent metadata to true and only disables tools when `compat.supportsTools === false` (`/tmp/openclaw-cap/src/agents/model-tool-support.ts:4`, `/tmp/openclaw-cap/src/agents/model-tool-support.ts:13`). Tool construction and compact paths gate on it (`/tmp/openclaw-cap/src/agents/embedded-agent-runner/run/attempt.ts:1221`, `/tmp/openclaw-cap/src/agents/embedded-agent-runner/compact.ts:916`), and OpenAI Completions only sends tools when supported (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:4344`). | No user/project per-model runtime gate found. Hermes models.dev has `supports_tools` metadata (`/tmp/hermes-cap/agent/models_dev.py:401`) parsed from `tool_call`, and catalog listing filters agentic models by tool-call support (`/tmp/hermes-cap/agent/models_dev.py:575`). Runtime chat completions sends tools whenever `tools` is supplied (`/tmp/hermes-cap/agent/transports/chat_completions.py:312`, `/tmp/hermes-cap/agent/transports/chat_completions.py:502`). | Useful for OpenClaw only when mapped to `compat.supportsTools`. Dead data for Hermes runtime projection. |
| `supports_reasoning` | Yes only if mapped to OpenClaw `reasoning`. The model schema has `reasoning` (`/tmp/openclaw-cap/src/config/types.models.ts:162`), missing values default to false (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:555`), Responses only emits reasoning controls when `model.reasoning` is true (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:2421`), and Completions similarly gates reasoning on `model.reasoning` (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:3703`, `/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:4452`). Thinking defaults also inspect configured `reasoning` (`/tmp/openclaw-cap/src/agents/model-thinking-default.ts:118`). | No user/project per-model runtime gate found. Hermes has `supports_reasoning` in models.dev metadata (`/tmp/hermes-cap/agent/models_dev.py:401`), but chat request reasoning support is passed from `agent._supports_reasoning_extra_body()` (`/tmp/hermes-cap/agent/chat_completion_helpers.py:826`, `/tmp/hermes-cap/agent/chat_completion_helpers.py:870`). That method derives support from provider/model/base-URL heuristics and probes, not config metadata (`/tmp/hermes-cap/run_agent.py:5303`, `/tmp/hermes-cap/run_agent.py:5310`, `/tmp/hermes-cap/run_agent.py:5322`, `/tmp/hermes-cap/run_agent.py:5331`). | Useful for OpenClaw only when mapped to `reasoning`. Dead data for Hermes runtime projection unless Hermes adds a config override later. |
| `max_input_tokens` | No for LLM model config. OpenClaw's LLM model config uses `contextWindow` / `contextTokens`; `maxInputTokens` search hits embedding/provider internals, not `models.providers.<id>.models[]` LLM budgeting. | No as a config/runtime LLM budget. Hermes has a model metadata field named `max_input_tokens` in `agent/model_metadata.py`, and models.dev parses `limit.input` (`/tmp/hermes-cap/agent/models_dev.py:626`), but runtime context budgeting uses `context_length` resolution (`/tmp/hermes-cap/agent/model_metadata.py:1886`). | Dead data for this projection. Use `context_window` / `context_length`. |
| `max_output_tokens` | Not as an OpenClaw model config field. OpenClaw model config uses `maxTokens`; outgoing Responses calls become `max_output_tokens` at transport time (`/tmp/openclaw-cap/src/agents/openai-transport-stream.ts:2380`). | Yes in provider/runtime fallback, not as a generic per-model capability object. Runtime provider accepts `max_output_tokens` or `max_tokens` on a custom provider entry (`/tmp/hermes-cap/hermes_cli/runtime_provider.py:586`, `/tmp/hermes-cap/hermes_cli/runtime_provider.py:589`, `/tmp/hermes-cap/hermes_cli/runtime_provider.py:594`) and gateway falls back to that when `model.max_tokens` is absent (`/tmp/hermes-cap/gateway/run.py:1850`). | Keep canonical `max_tokens` for now and map to the target's output-cap field. Adding a duplicate `max_output_tokens` is not necessary unless doing a schema rename/migration for clarity. |

## Agent-Specific Notes

### OpenClaw

OpenClaw consumes model entries under `models.providers.<id>.models[]` through a
typed model definition. That type includes `id`, `name`, `api`, `baseUrl`,
`reasoning`, `input`, `cost`, `contextWindow`, `contextTokens`, `maxTokens`,
`thinkingLevelMap`, `params`, runtime fields, headers, and `compat`
(`/tmp/openclaw-cap/src/config/types.models.ts:153`). It does not include
snake_case `supports_vision`, `supports_tools`, `supports_reasoning`,
`max_input_tokens`, or `max_output_tokens`.

Important defaults:

- Missing `reasoning` becomes `false` (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:555`).
  This is wrong for reasoning models if we want OpenClaw to expose reasoning
  controls.
- Missing `input` becomes `["text"]` (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:557`).
  This is wrong for vision models because image parts will be dropped or routed
  through fallback paths.
- Missing `contextWindow` becomes `128000` in registry resolution
  (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:559`) and may also
  interact with fixed/fallback runtime caps (`/tmp/openclaw-cap/src/agents/context-resolution.ts:240`).
  This can be wrong for larger or smaller managed models.
- Missing `maxTokens` becomes `16384` (`/tmp/openclaw-cap/src/agents/sessions/model-registry.ts:560`).
  This can be wrong for models with very different output caps.
- Missing `compat.supportsTools` defaults permissive (`true`) because only
  explicit `false` disables tools (`/tmp/openclaw-cap/src/agents/model-tool-support.ts:13`).
  This can be wrong for non-tool models because OpenClaw may send tool schemas.

### Hermes

Hermes has a mixed model-metadata story:

- It really does consume `supports_vision` from config and uses it to decide
  whether image content is sent natively or converted/stripped
  (`/tmp/hermes-cap/agent/image_routing.py:180`,
  `/tmp/hermes-cap/run_agent.py:4872`).
- It consumes `context_length` from config/custom providers for runtime context
  length (`/tmp/hermes-cap/agent/agent_init.py:1620`,
  `/tmp/hermes-cap/agent/agent_init.py:1658`).
- It consumes `model.max_tokens` and provider `max_output_tokens` as output
  caps (`/tmp/hermes-cap/gateway/run.py:1846`,
  `/tmp/hermes-cap/gateway/run.py:1850`).
- It has models.dev capability metadata for tools, vision, reasoning, context,
  and output caps (`/tmp/hermes-cap/agent/models_dev.py:401`), but that metadata
  is not equivalent to a user/project config capability schema. Runtime tool
  gating and reasoning gating are not driven by user per-model
  `supports_tools` / `supports_reasoning` config fields.

## Recommended Final Projection Set

For the v2 managed provider, keep the backend/catalog schema small but carry the
fields that can be mapped into real agent behavior:

| Canonical Clawdi field | OpenClaw projection | Hermes projection |
| --- | --- | --- |
| `id` | `id` | model id |
| `context_window` | `contextWindow` | `context_length` |
| `max_tokens` | `maxTokens` | `model.max_tokens` or provider `max_output_tokens` |
| `input_modalities` | `input` | derive `supports_vision` when `image` is present |
| `supports_vision` | derive/confirm `input` contains `image`; do not emit raw field | `supports_vision` |
| `supports_tools` | `compat.supportsTools` | do not project for runtime |
| `supports_reasoning` | `reasoning` | do not project for runtime |

Not recommended:

- `max_input_tokens`: no useful agent runtime consumer in either target.
- A duplicate `max_output_tokens` next to `max_tokens`: useful only if we choose
  to rename the existing output-cap field. For now, `max_tokens` is already the
  output cap in Clawdi and can map to each target's native field.

## Answer to the Owner Question

Yes, add more than the already projected `context_window`, `max_tokens`, and
`input_modalities`, but only where the agent actually consumes them:

- Add `supports_vision` because Hermes acts on it. It also provides a canonical
  boolean that can be kept in sync with `input_modalities`.
- Add `supports_tools` if OpenClaw is a target, and project it as
  `compat.supportsTools`.
- Add `supports_reasoning` if OpenClaw is a target, and project it as
  `reasoning`.
- Do not add `max_input_tokens`.
- Do not add `max_output_tokens` as a second output-cap field unless we decide
  to migrate away from the existing `max_tokens` name.
