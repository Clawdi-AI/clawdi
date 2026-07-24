import { describe, expect, test } from "bun:test";
import {
	type AiProviderCatalog,
	CLAWDI_MANAGED_PROVIDER_ID,
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
	test("projects the bare managed provider alias with the managed endpoint and key env", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: CLAWDI_MANAGED_PROVIDER_ID,
					type: "custom_openai_compatible",
					label: "Managed by Clawdi",
					base_url: "https://managed.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
					models: [{ id: "managed-model" }],
				},
			],
			defaults: { chat_provider_id: CLAWDI_MANAGED_PROVIDER_ID },
		};
		const primaryModel = {
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
			model: "managed-model",
		};

		const openclaw = buildAgentTargetProjection("openclaw", catalog, primaryModel);
		expect(openclaw.provider_ids).toEqual([CLAWDI_MANAGED_PROVIDER_ID]);
		expect(openclaw.primary_model).toEqual(primaryModel);
		const openclawPatch = JSON.parse(openclaw.files[0]?.content ?? "{}") as {
			agents?: { defaults?: { model?: { primary?: string } } };
			models?: {
				providers?: Record<string, { api?: string; apiKey?: { id?: string }; baseUrl?: string }>;
			};
		};
		expect(openclawPatch.agents?.defaults?.model?.primary).toBe("clawdi/managed-model");
		expect(openclawPatch.models?.providers?.[CLAWDI_MANAGED_PROVIDER_ID]).toMatchObject({
			baseUrl: "https://managed.example.test/v1",
			apiKey: { id: "CLAWDI_MANAGED_OPENAI_API_KEY" },
		});
		// openai_chat is OpenClaw's default custom-provider mode and is intentionally omitted.
		expect(openclawPatch.models?.providers?.[CLAWDI_MANAGED_PROVIDER_ID]?.api).toBeUndefined();
		expect(JSON.stringify(openclawPatch)).not.toContain("clawdi-v2");

		const hermes = buildAgentTargetProjection("hermes", catalog, primaryModel);
		expect(hermes.provider_ids).toEqual([CLAWDI_MANAGED_PROVIDER_ID]);
		expect(hermes.files[0]?.content).toContain('provider: "custom:clawdi"');
		expect(hermes.files[0]?.content).toContain('"clawdi":');
		expect(hermes.files[0]?.content).toContain('api: "https://managed.example.test/v1"');
		expect(hermes.files[0]?.content).toContain('transport: "chat_completions"');
		expect(hermes.files[0]?.content).toContain('key_env: "CLAWDI_MANAGED_OPENAI_API_KEY"');
		expect(hermes.files[0]?.content).not.toContain("clawdi-v2");
	});

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
								max_input_tokens: 1_048_576,
							},
							{
								id: "kimi-for-coding",
								context_length: 262_144,
								max_input_tokens: 262_144,
							},
							{
								id: "kimi-for-coding-highspeed",
								context_length: 262_144,
								max_input_tokens: 262_144,
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
		});
		expect(openclawModels[1]?.maxTokens).toBeUndefined();
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
		expect(codingBlock).not.toContain("max_tokens:");
		const highspeedBlock = hermes.files[0]?.content.split('"kimi-for-coding-highspeed":')[1];
		expect(highspeedBlock).toContain("context_length: 262144");
		expect(highspeedBlock).not.toContain("max_tokens:");
	});

	test("normalizes a generic max_output_tokens discovery alias for both targets", () => {
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
								id: "generic-output-alias",
								context_length: 400_000,
								max_input_tokens: 350_000,
								max_output_tokens: 16_384,
							},
						],
					}),
				},
			],
			defaults: { chat_provider_id: "clawdi-v2" },
		};

		const primaryModel = { provider_id: "clawdi-v2", model: "generic-output-alias" };
		const openclaw = buildAgentTargetProjection("openclaw", catalog, primaryModel);
		const openclawPatch = JSON.parse(openclaw.files[0]?.content ?? "{}") as {
			models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
		};
		expect(openclawPatch.models?.providers?.["clawdi-v2"]?.models?.[0]).toMatchObject({
			id: "generic-output-alias",
			contextWindow: 400_000,
			maxTokens: 16_384,
		});

		const hermes = buildAgentTargetProjection("hermes", catalog, primaryModel);
		expect(hermes.files[0]?.content).toContain('"generic-output-alias":');
		expect(hermes.files[0]?.content).toContain("context_length: 400000");
		expect(hermes.files[0]?.content).toContain("max_tokens: 16384");
	});
});
