# Core Web AI Provider Catalog Audit

This audit covers the Core Web provider types and presets in
`packages/shared/src/ai-provider.ts` and
`apps/web/src/hosted/v2/ai-providers/provider-presets.ts`.

- Baseline: `b934e59e`
- Access date for every source below: `2026-07-31`
- Scope: public first-party documentation and public first-party catalog source
  only; no authenticated or inference APIs were called.
- Selection rule: keep a small set of current general or agent-oriented models,
  retain documented stable aliases, and omit context metadata unless the
  provider publishes an exact value.

## Verified Catalog

| Provider or preset | Curated models, first is the default | Endpoint, protocol, authentication, and key boundary | Retirement decision |
| --- | --- | --- | --- |
| OpenAI API | `gpt-5.6-sol` (1,050,000), `gpt-5.6-terra` (1,050,000), `gpt-5.6-luna` (1,050,000) | `https://api.openai.com/v1`; Responses or Chat Completions; Bearer API key; [organization API keys](https://platform.openai.com/settings/organization/api-keys) | Replaces the older Core Web GPT-5.5/5.4 set. OpenAI's deprecation table names the matching GPT-5.6 tiers as replacements for older GPT-5 snapshots. |
| ChatGPT sign-in (Codex OAuth) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; context omitted because Codex product limits are not OpenAI API context metadata | Existing Codex agent-profile flow; no runtime or OAuth contract change | The public Codex catalog lists these three first and visible. Hidden or older entries are not seeded into a new connection. |
| Anthropic | `claude-sonnet-5` (1,000,000), `claude-opus-5` (1,000,000), `claude-haiku-4-5` (200,000) | `https://api.anthropic.com`; Messages API; `x-api-key`; [Claude API keys](https://platform.claude.com/settings/keys); supported-country boundary applies | Opus 5 replaces Opus 4.6 in the curated set. Current model IDs are absent from the retirement table. |
| OpenRouter | `openrouter/auto-beta` (2,000,000), `~openai/gpt-latest` (1,050,000), `anthropic/claude-sonnet-5` (1,000,000) | `https://openrouter.ai/api/v1`; OpenAI-compatible Chat Completions; Bearer key; [OpenRouter keys](https://openrouter.ai/keys) | `openrouter/auto` is deprecated; the catalog already uses its documented replacement, `openrouter/auto-beta`. |
| Google Gemini | `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, each 1,048,576 | Native: `https://generativelanguage.googleapis.com/v1beta`, `generateContent`, `x-goog-api-key`. Preset: `https://generativelanguage.googleapis.com/v1beta/openai`, OpenAI-compatible Chat Completions, Bearer key. [Google AI Studio keys](https://aistudio.google.com/apikey) | `gemini-2.5-pro` has a 2026-10-16 shutdown date. It is removed without adding its preview replacement. |
| Mistral AI | `mistral-medium-latest`, `mistral-small-latest`, `mistral-large-latest`, each 256,000 | `https://api.mistral.ai/v1`; OpenAI-compatible Chat Completions; Bearer API key; [Mistral API keys](https://console.mistral.ai/api-keys) | The aliases currently resolve to Medium 3.5, Small 4, and Large 3. Codestral remains valid but is specialized for fill-in-the-middle and is omitted from the concise general catalog. |
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-pro`, each 1,000,000 | `https://api.deepseek.com`; OpenAI-compatible Chat Completions; Bearer API key; [DeepSeek keys](https://platform.deepseek.com/api_keys). The documented `/v1` compatibility form is retained. | `deepseek-chat` and `deepseek-reasoner` retired on 2026-07-24; neither remains in the preset. |
| Kimi Code | `k3-256k` (262,144), `k3` (context omitted), `kimi-for-coding` (262,144) | `https://api.kimi.com/coding/`; Anthropic-compatible Messages; API key; [Kimi Code console](https://www.kimi.com/code/console). Kimi Code membership keys are distinct from Kimi Platform keys. | `k3-256k` is the documented everyday-use choice. `k3` access can provide up to 1M depending on membership, so no exact context is stored. |
| Kimi API | `kimi-k3` (1,000,000) | China: `https://api.moonshot.cn/v1` and [.com keys](https://platform.kimi.com/console/api-keys). Global: `https://api.moonshot.ai/v1` and [.ai keys](https://platform.kimi.ai/console/api-keys). OpenAI-compatible Chat Completions with Bearer keys. | Kimi K2-series models retired 2026-05-25 and `kimi-latest` retired 2026-01-28; the preset offers only K3. |
| Qwen on Alibaba Cloud Model Studio | `qwen3.7-plus` (1,000,000), `qwen3.7-max` (1,000,000), `qwen3-coder-next` (262,144) | China (Beijing): `https://dashscope.aliyuncs.com/compatible-mode/v1`. Singapore: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. OpenAI-compatible Chat Completions with Bearer keys. Keys and model availability are region-bound and cannot cross regions. | All three IDs have current official model cards. Workspace-dedicated domains are recommended for production but require a user-specific workspace ID, so they cannot be a static preset. |
| Z.AI / Zhipu GLM | `glm-5.2` (1,000,000), `glm-5.1` (200,000), `glm-4.7` (200,000) | China: `https://open.bigmodel.cn/api/paas/v4` and [Zhipu keys](https://bigmodel.cn/usercenter/proj-mgmt/apikeys). Global: `https://api.z.ai/api/paas/v4` and [Z.AI keys](https://z.ai/manage-apikey/apikey-list). OpenAI-compatible Chat Completions with Bearer keys. | Current CN and global model matrices contain all three. Published retirement entries affect older GLM families, not this set. |
| StepFun | `step-3.7-flash` (262,144) | Global: `https://api.stepfun.ai/v1` and [.ai keys](https://platform.stepfun.ai/interface-key). China: `https://api.stepfun.com/v1` and [.com keys](https://platform.stepfun.com/interface-key). OpenAI-compatible Chat Completions with Bearer keys. | Current global and China documentation both present Step 3.7 Flash as the flagship multimodal reasoning model. No dated retirement notice for it was found. |
| MiniMax | `MiniMax-M3` (1,000,000), `MiniMax-M2.7` (204,800) | `https://api.minimax.io/v1`; OpenAI-compatible Chat Completions with Bearer API key; [MiniMax keys](https://platform.minimax.io/user-center/basic-information/interface-key) | `MiniMax-M2` is under the official Legacy Models section and is removed. M3 and M2.7 are the current M-series entries. |
| Together AI | `MiniMaxAI/MiniMax-M3` (524,288), `zai-org/GLM-5.2` (262,144) | `https://api.together.ai/v1`; OpenAI-compatible Chat Completions; project-scoped Bearer API key; [project API keys](https://api.together.ai/settings/projects/~current/api-keys) | Both IDs are current serverless chat models and absent from scheduled deprecations. Legacy organization keys are deprecated, so the acquisition link now opens project keys. |
| Groq | `openai/gpt-oss-120b` (131,072) | `https://api.groq.com/openai/v1`; OpenAI-compatible Chat Completions; Bearer API key; [Groq keys](https://console.groq.com/keys) | The model is in Groq's Production Models table and not its deprecated-model table. |
| xAI | `grok-4.5` (500,000) | `https://api.x.ai/v1`; OpenAI-compatible Chat Completions; Bearer API key; [xAI keys](https://console.x.ai/team/default/api-keys) | `grok-4.5` and its stable aliases are current. The published May 15 retirement affects older models, not this preset. |
| Custom OpenAI-compatible | No seeded models | User-supplied endpoint, API mode, and authentication | No provider catalog can be verified; the form intentionally remains empty. |

## Official Sources

### OpenAI and Codex

- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol.md)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra.md)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna.md)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI Codex repository](https://github.com/openai/codex)
- [Codex public model catalog](https://github.com/openai/codex/blob/ef293f7ac9d756f793f3e952a790f9bec16a6eeb/codex-rs/models-manager/models.json)

### Anthropic

- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)
- [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations.md)
- [Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages.md)
- [API keys](https://platform.claude.com/docs/en/get-api-key.md)
- [Supported countries and regions](https://platform.claude.com/docs/en/api/supported-regions.md)

### OpenRouter

- [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)
- [Models](https://openrouter.ai/docs/guides/overview/models.md)
- [Authentication](https://openrouter.ai/docs/api_reference/authentication.md)
- [Public model catalog](https://openrouter.ai/api/v1/models)

### Google Gemini

- [Models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash)
- [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)
- [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [API keys](https://ai.google.dev/gemini-api/docs/api-key)

### Mistral AI

- [Models overview](https://docs.mistral.ai/models)
- [Mistral Medium 3.5](https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04)
- [Mistral Small 4](https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03)
- [Mistral Large 3](https://docs.mistral.ai/models/model-cards/mistral-large-3-25-12)
- [Codestral](https://docs.mistral.ai/models/model-cards/codestral-25-08)
- [API reference](https://docs.mistral.ai/api/)

### DeepSeek, Kimi, and Qwen

- [DeepSeek API documentation](https://api-docs.deepseek.com/)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek updates](https://api-docs.deepseek.com/updates)
- [DeepSeek V4 update](https://api-docs.deepseek.com/news/news260424)
- [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [Kimi Code overview](https://www.kimi.com/code/docs/en/)
- [Kimi API models](https://platform.kimi.ai/docs/models.md)
- [Kimi API overview](https://platform.kimi.ai/docs/api/overview.md)
- [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart.md)
- [Kimi China models](https://platform.kimi.com/docs/models.md)
- [Kimi China API overview](https://platform.kimi.com/docs/api/overview.md)
- [Alibaba Cloud Model Studio model list](https://www.alibabacloud.com/help/en/model-studio/models.md)
- [Qwen3.7 Plus](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-plus.md)
- [Qwen3.7 Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-max.md)
- [Qwen3 Coder Next](https://www.alibabacloud.com/help/en/model-studio/qwen3-coder-next.md)
- [Model Studio base URLs](https://www.alibabacloud.com/help/en/model-studio/base-url.md)
- [Model Studio regions](https://www.alibabacloud.com/help/en/model-studio/regions.md)

### Z.AI, StepFun, and MiniMax

- [Zhipu model overview](https://docs.bigmodel.cn/cn/guide/start/model-overview.md)
- [GLM-5.2](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2.md)
- [GLM-5.1](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.1.md)
- [GLM-4.7](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7.md)
- [Zhipu OpenAI compatibility](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction.md)
- [Z.AI model overview](https://docs.z.ai/guides/overview/overview.md)
- [Z.AI GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2.md)
- [StepFun Step 3.7 Flash](https://platform.stepfun.ai/docs/en/guides/models/step-3.7-flash.md)
- [StepFun global quickstart](https://platform.stepfun.ai/docs/en/quickstart.md)
- [StepFun China quickstart](https://platform.stepfun.com/docs/zh/quickstart.md)
- [MiniMax models](https://platform.minimax.io/docs/guides/models-intro.md)
- [MiniMax model release notes](https://platform.minimax.io/docs/release-notes/models.md)
- [MiniMax OpenAI compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api.md)
- [MiniMax API keys](https://platform.minimax.io/docs/guides/quickstart-preparation.md)

### Together AI, Groq, and xAI

- [Together serverless models](https://docs.together.ai/docs/serverless/models.md)
- [Together deprecations](https://docs.together.ai/docs/deprecations.md)
- [Together authentication](https://docs.together.ai/docs/api-keys-authentication.md)
- [Together OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility.md)
- [Together GLM-5.2 quickstart](https://docs.together.ai/docs/glm-5.2-quickstart.md)
- [Groq models](https://console.groq.com/docs/models)
- [Groq GPT-OSS 120B](https://console.groq.com/docs/model/openai/gpt-oss-120b)
- [Groq deprecations](https://console.groq.com/docs/deprecations)
- [Groq OpenAI compatibility](https://console.groq.com/docs/openai)
- [xAI Grok 4.5](https://docs.x.ai/developers/models/grok-4.5.md)
- [xAI quickstart](https://docs.x.ai/developers/quickstart.md)
- [xAI Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat.md)
- [xAI May 15 retirement](https://docs.x.ai/developers/migration/may-15-retirement.md)

## Remaining Uncertainty

- Codex's public model catalog is a rolling source file. The audit pins the
  observed source commit, but availability can still depend on account rollout.
- Kimi Code documents `k3` as supporting up to 1M context depending on
  membership. The exact context is intentionally omitted; `k3-256k` is used as
  the deterministic default.
- Mistral `*-latest` IDs are intentional stable aliases. Their display names
  describe the models they resolved to on the access date and will require a
  future catalog audit when the aliases advance.
- Qwen keys, model availability, and access domains are region-bound. The
  static preset exposes only the shared China (Beijing) and Singapore DashScope
  domains; workspace-specific domains cannot be generated without a workspace
  ID.
- No dated retirement notice was found for the current Step 3.7 Flash model.
  Its official model page and both regional quickstarts were current on the
  access date.
- Gemini's documented replacement for 2.5 Pro is a preview model. It is not
  added to the curated production-oriented set.

Verification for this audit is recorded in the final review report: focused
shared and Web catalog tests, Web typecheck, Biome, and the OSS Web build.
