import { describe, expect, test } from "bun:test";
import {
	type AiProviderCatalog,
	CODEX_OAUTH_MODEL_CATALOG,
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	defaultAiProviderModels,
	defaultAiProviderRuntimeEnvName,
} from "@clawdi/shared";
import { extractManagedLiveModels } from "../runtime/managed-model-resolution";
import { buildAgentTargetProjection } from "./ai-provider-projection";

const byokOpenAiCatalog: AiProviderCatalog = {
	schema_version: 1,
	providers: [
		{
			id: "openai-main",
			type: "openai",
			label: "OpenAI",
			base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
			api_mode: defaultAiProviderApiMode("openai") ?? "openai_responses",
			auth: { type: "api_key", source: "managed" },
			managed_by: "user",
			runtime_env_name: defaultAiProviderRuntimeEnvName("openai") ?? "OPENAI_API_KEY",
			models: defaultAiProviderModels("openai").map((model) => ({ ...model })),
		},
	],
	defaults: { chat_provider_id: "openai-main" },
};

const codexOAuthCatalog: AiProviderCatalog = {
	schema_version: 1,
	providers: [
		{
			id: "openai-codex",
			type: "openai",
			label: "Codex (ChatGPT)",
			base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
			api_mode: "openai_responses",
			auth: { type: "agent_profile", tool: "codex", profile: "default" },
			managed_by: "user",
			models: CODEX_OAUTH_MODEL_CATALOG.map((model) => ({ ...model })),
		},
	],
	defaults: { chat_provider_id: "openai-codex" },
};

describe("AI provider projection", () => {
	test("maps known BYOK OpenAI providers to all runtime targets without extra user fields", () => {
		const openclaw = buildAgentTargetProjection("openclaw", byokOpenAiCatalog);
		expect(openclaw.provider_ids).toEqual(["openai-main"]);
		expect(openclaw.primary_model).toEqual({ provider_id: "openai-main", model: "gpt-5.5" });
		expect(openclaw.files[0]?.content).toContain('"baseUrl": "https://api.openai.com/v1"');
		expect(openclaw.files[0]?.content).toContain('"api": "openai-responses"');
		expect(openclaw.files[0]?.content).toContain('"id": "OPENAI_API_KEY"');

		const hermes = buildAgentTargetProjection("hermes", byokOpenAiCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "custom:openai-main"');
		expect(hermes.files[0]?.content).toContain('api: "https://api.openai.com/v1"');
		expect(hermes.files[0]?.content).toContain('transport: "codex_responses"');
		expect(hermes.files[0]?.content).toContain('key_env: "OPENAI_API_KEY"');

		const codex = buildAgentTargetProjection("codex", byokOpenAiCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.5"');
		expect(codex.files[0]?.content).toContain('model_provider = "openai-main"');
		expect(codex.files[0]?.content).toContain('[model_providers."openai-main"]');
		expect(codex.files[0]?.content).toContain('env_key = "OPENAI_API_KEY"');
	});

	test("keeps native Codex OAuth projections on the verified OpenAI/Codex path", () => {
		const openclaw = buildAgentTargetProjection("openclaw", codexOAuthCatalog);
		expect(openclaw.files[0]?.content).toContain('"plugins": {');
		expect(openclaw.files[0]?.content).toContain('"primary": "openai/gpt-5.5"');

		const hermes = buildAgentTargetProjection("hermes", codexOAuthCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "openai-codex"');
		expect(hermes.files[0]?.content).toContain('default: "gpt-5.5"');
		expect(hermes.files[0]?.content).toContain('base_url: "https://chatgpt.com/backend-api/codex"');

		const codex = buildAgentTargetProjection("codex", codexOAuthCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.5"');
		expect(codex.files[0]?.content).toContain('model_provider = "openai"');
		expect(codex.files[0]?.content).not.toContain('[model_providers."openai-codex"]');
	});

	test("projects model alias and cost metadata to runtime-native fields", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: "custom-main",
					type: "custom_openai_compatible",
					base_url: "https://api.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "env", ref: "env:CUSTOM_API_KEY" },
					runtime_env_name: "CUSTOM_API_KEY",
					models: [
						{
							id: "example-model",
							alias: "Example Model",
							context_window: 128_000,
							cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0 },
						},
					],
				},
			],
			defaults: { chat_provider_id: "custom-main" },
		};

		const openclaw = buildAgentTargetProjection("openclaw", catalog);
		expect(openclaw.files[0]?.content).toContain('"name": "Example Model"');
		expect(openclaw.files[0]?.content).toContain('"cost": {');
		expect(openclaw.files[0]?.content).toContain('"cacheRead": 0.06');
		expect(openclaw.files[0]?.content).toContain('"cacheWrite": 0');

		const hermes = buildAgentTargetProjection("hermes", catalog);
		expect(hermes.files[0]?.content).toContain("input_cost_per_million: 0.3");
		expect(hermes.files[0]?.content).toContain("output_cost_per_million: 1.2");
		expect(hermes.files[0]?.content).toContain("cache_read_cost_per_million: 0.06");
		expect(hermes.files[0]?.content).toContain("cache_write_cost_per_million: 0");
	});

	test("projects Sub2API overlay metadata without inventing a missing output cap", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: "clawdi-v2",
					type: "custom_openai_compatible",
					base_url: "https://api.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "OPENAI_API_KEY",
					models: extractManagedLiveModels({
						data: [
							{
								id: "k3",
								context_length: 1_048_576,
								max_input_tokens: 229_376,
							},
							{
								id: "kimi-for-coding",
								context_length: 262_144,
								max_input_tokens: 229_376,
								max_output_tokens: 32_768,
							},
							{
								id: "kimi-for-coding-highspeed",
								context_length: 262_144,
								max_input_tokens: 229_376,
							},
						],
					}),
				},
			],
			defaults: { chat_provider_id: "clawdi-v2" },
		};

		const openclaw = buildAgentTargetProjection("openclaw", catalog, {
			provider_id: "clawdi-v2",
			model: "k3",
		});
		const openclawPatch = JSON.parse(openclaw.files[0]?.content ?? "{}") as {
			models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
		};
		const openclawModels = openclawPatch.models?.providers?.["clawdi-v2"]?.models ?? [];
		expect(openclawModels[0]).toMatchObject({
			id: "k3",
			contextWindow: 1_048_576,
		});
		expect(openclawModels[0]?.maxTokens).toBeUndefined();
		expect(openclawModels[1]).toMatchObject({
			id: "kimi-for-coding",
			contextWindow: 262_144,
			maxTokens: 32_768,
		});
		expect(openclawModels[2]).toMatchObject({
			id: "kimi-for-coding-highspeed",
			contextWindow: 262_144,
		});
		expect(openclawModels[2]?.maxTokens).toBeUndefined();

		const hermes = buildAgentTargetProjection("hermes", catalog, {
			provider_id: "clawdi-v2",
			model: "k3",
		});
		const k3Block = hermes.files[0]?.content.split('"k3":')[1]?.split('"kimi-for-coding":')[0];
		expect(k3Block).toContain("context_length: 1048576");
		expect(k3Block).not.toContain("max_tokens:");
		const codingBlock = hermes.files[0]?.content
			.split('"kimi-for-coding":')[1]
			?.split('"kimi-for-coding-highspeed":')[0];
		expect(codingBlock).toContain("context_length: 262144");
		expect(codingBlock).toContain("max_tokens: 32768");
		const highspeedBlock = hermes.files[0]?.content.split('"kimi-for-coding-highspeed":')[1];
		expect(highspeedBlock).toContain("context_length: 262144");
		expect(highspeedBlock).not.toContain("max_tokens:");
	});
});
