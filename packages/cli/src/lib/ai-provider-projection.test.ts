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
import { parse as parseYaml } from "yaml";
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
	test("projects complete keyed Hermes providers without embedding secrets", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: CLAWDI_MANAGED_PROVIDER_ID,
					type: "custom_openai_compatible",
					base_url: "https://managed.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_AI_API_KEY",
					models: [{ id: "managed-model" }],
				},
				{
					id: "kimi-coding",
					type: "anthropic",
					base_url: "https://api.kimi.com/coding",
					api_mode: "anthropic_messages",
					auth: { type: "api_key", source: "managed" },
					runtime_env_name: "KIMI_CODING_API_KEY",
					models: [{ id: "kimi-for-coding" }],
				},
				{
					id: "openai-responses",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					api_mode: "openai_responses",
					auth: { type: "api_key", source: "managed" },
					runtime_env_name: "OPENAI_RESPONSES_API_KEY",
					models: [{ id: "gpt-5.5" }],
				},
				{
					id: "anthropic-proxy",
					type: "anthropic",
					base_url: "https://anthropic.example.test",
					api_mode: "anthropic_messages",
					auth: { type: "api_key", source: "managed" },
					runtime_env_name: "ANTHROPIC_PROXY_API_KEY",
					models: [{ id: "claude-test" }],
				},
			],
		};
		const cases = [
			{
				providerId: CLAWDI_MANAGED_PROVIDER_ID,
				model: "managed-model",
				envName: "CLAWDI_AI_API_KEY",
				baseUrl: "https://managed.example.test/v1",
				apiMode: "chat_completions",
			},
			{
				providerId: "kimi-coding",
				model: "kimi-for-coding",
				envName: "KIMI_CODING_API_KEY",
				baseUrl: "https://api.kimi.com/coding",
				apiMode: "anthropic_messages",
			},
			{
				providerId: "openai-responses",
				model: "gpt-5.5",
				envName: "OPENAI_RESPONSES_API_KEY",
				baseUrl: "https://api.openai.com/v1",
				apiMode: "codex_responses",
			},
			{
				providerId: "anthropic-proxy",
				model: "claude-test",
				envName: "ANTHROPIC_PROXY_API_KEY",
				baseUrl: "https://anthropic.example.test",
				apiMode: "anthropic_messages",
			},
		] as const;

		for (const testCase of cases) {
			const projection = buildAgentTargetProjection("hermes", catalog, {
				provider_id: testCase.providerId,
				model: testCase.model,
			});
			const content = projection.files[0]?.content ?? "";
			const config = parseYaml(content) as {
				model?: { default?: string; provider?: string };
				providers?: Record<
					string,
					{
						api?: string;
						discover_models?: boolean;
						key_env?: string;
						models?: Record<string, unknown>;
						transport?: string;
					}
				>;
			};
			expect(config.model).toMatchObject({
				default: testCase.model,
				provider: `custom:${testCase.providerId}`,
			});
			expect(config.providers?.[testCase.providerId]).toMatchObject({
				api: testCase.baseUrl,
				key_env: testCase.envName,
				models: { [testCase.model]: {} },
				transport: testCase.apiMode,
			});
			expect(config.providers?.[testCase.providerId]).not.toHaveProperty("discover_models");
			expect(content).not.toContain("sentinel-secret-value");
		}

		const frozen = buildAgentTargetProjection(
			"hermes",
			catalog,
			{ provider_id: CLAWDI_MANAGED_PROVIDER_ID, model: "managed-model" },
			{ freezeManagedModelCatalog: true },
		);
		const frozenProviders = (
			parseYaml(frozen.files[0]?.content ?? "") as {
				providers?: Record<string, { discover_models?: boolean }>;
			}
		).providers;
		expect(frozenProviders?.[CLAWDI_MANAGED_PROVIDER_ID]?.discover_models).toBe(false);
		for (const providerId of ["kimi-coding", "openai-responses", "anthropic-proxy"]) {
			expect(frozenProviders?.[providerId]).not.toHaveProperty("discover_models");
		}
	});

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
					runtime_env_name: "CLAWDI_AI_API_KEY",
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
			apiKey: { id: "CLAWDI_AI_API_KEY" },
		});
		expect(Object.keys(openclawPatch.models?.providers ?? {})).toEqual([
			CLAWDI_MANAGED_PROVIDER_ID,
		]);
		expect(openclawPatch).not.toHaveProperty("plugins");
		expect(JSON.stringify(openclawPatch)).not.toContain("secret://");
		expect(JSON.stringify(openclawPatch).toLowerCase()).not.toContain("vault");
		// openai_chat is OpenClaw's default custom-provider mode and is intentionally omitted.
		expect(openclawPatch.models?.providers?.[CLAWDI_MANAGED_PROVIDER_ID]?.api).toBeUndefined();
		expect(JSON.stringify(openclawPatch)).not.toContain("clawdi-v2");

		const hermes = buildAgentTargetProjection("hermes", catalog, primaryModel);
		expect(hermes.provider_ids).toEqual([CLAWDI_MANAGED_PROVIDER_ID]);
		expect(hermes.files[0]?.content).toContain('provider: "custom:clawdi"');
		expect(hermes.files[0]?.content).toContain('"clawdi":');
		expect(hermes.files[0]?.content).toContain('api: "https://managed.example.test/v1"');
		expect(hermes.files[0]?.content).toContain('transport: "chat_completions"');
		expect(hermes.files[0]?.content).toContain('key_env: "CLAWDI_AI_API_KEY"');
		expect(hermes.files[0]?.content).toContain('"managed-model": {}');
		expect(hermes.files[0]?.content).not.toContain("clawdi-v2");
	});

	test("accepts the legacy public managed id but only emits clawdi", () => {
		const legacyProviderId = "clawdi-v2";
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: legacyProviderId,
					type: "custom_openai_compatible",
					base_url: "https://managed.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_AI_API_KEY",
					models: [{ id: "managed-model" }],
				},
			],
			defaults: { chat_provider_id: legacyProviderId },
		};
		const primaryModel = { provider_id: legacyProviderId, model: "managed-model" };

		for (const target of ["openclaw", "hermes"] as const) {
			const projection = buildAgentTargetProjection(target, catalog, primaryModel);
			expect(projection.provider_ids).toEqual([CLAWDI_MANAGED_PROVIDER_ID]);
			expect(projection.default_provider_id).toBe(CLAWDI_MANAGED_PROVIDER_ID);
			expect(projection.primary_model.provider_id).toBe(CLAWDI_MANAGED_PROVIDER_ID);
			expect(projection.files[0]?.content).not.toContain(legacyProviderId);
		}
	});

	test("maps known BYOK OpenAI providers to all runtime targets without extra user fields", () => {
		const openclaw = buildAgentTargetProjection("openclaw", byokOpenAiCatalog);
		expect(openclaw.provider_ids).toEqual(["openai-main"]);
		expect(openclaw.primary_model).toEqual({
			provider_id: "openai-main",
			model: "gpt-5.6-sol",
		});
		expect(openclaw.files[0]?.content).toContain('"baseUrl": "https://api.openai.com/v1"');
		expect(openclaw.files[0]?.content).toContain('"api": "openai-responses"');
		expect(openclaw.files[0]?.content).toContain('"id": "OPENAI_API_KEY"');

		const hermes = buildAgentTargetProjection("hermes", byokOpenAiCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "custom:openai-main"');
		expect(hermes.files[0]?.content).toContain('api: "https://api.openai.com/v1"');
		expect(hermes.files[0]?.content).toContain('transport: "codex_responses"');
		expect(hermes.files[0]?.content).toContain('key_env: "OPENAI_API_KEY"');

		const codex = buildAgentTargetProjection("codex", byokOpenAiCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.6-sol"');
		expect(codex.files[0]?.content).toContain('model_provider = "openai-main"');
		expect(codex.files[0]?.content).toContain('[model_providers."openai-main"]');
		expect(codex.files[0]?.content).toContain('env_key = "OPENAI_API_KEY"');
	});

	test("projects Gemini only to the runtime with a verified transport", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: "gemini-main",
					type: "gemini",
					base_url: "https://generativelanguage.googleapis.com/v1beta",
					api_mode: "google_generate_content",
					auth: { type: "api_key", source: "managed" },
					runtime_env_name: "GEMINI_API_KEY",
					models: [{ id: "gemini-2.5-pro" }],
				},
			],
			defaults: { chat_provider_id: "gemini-main" },
		};

		expect(buildAgentTargetProjection("openclaw", catalog).provider_ids).toEqual(["gemini-main"]);
		expect(() => buildAgentTargetProjection("hermes", catalog)).toThrow(
			"does not map to a verified Hermes custom-provider transport",
		);
	});

	test("rejects non-canonical Codex auth profiles from Codex projection", () => {
		const catalog: AiProviderCatalog = {
			...codexOAuthCatalog,
			providers: [
				{
					...codexOAuthCatalog.providers[0],
					base_url: "https://openai-proxy.example.test/v1",
				},
			],
		};

		expect(() => buildAgentTargetProjection("codex", catalog)).toThrow(
			"provider protocol and auth shape are not runtime-compatible",
		);
	});

	test("keeps native Codex OAuth projections on the verified OpenAI/Codex path", () => {
		const openclaw = buildAgentTargetProjection("openclaw", codexOAuthCatalog);
		expect(openclaw.files[0]?.content).toContain('"plugins": {');
		expect(openclaw.files[0]?.content).toContain('"primary": "openai/gpt-5.6-sol"');

		const hermes = buildAgentTargetProjection("hermes", codexOAuthCatalog);
		expect(hermes.files[0]?.content).toContain('provider: "openai-codex"');
		expect(hermes.files[0]?.content).toContain('default: "gpt-5.6-sol"');
		expect(hermes.files[0]?.content).not.toContain("base_url:");

		const codex = buildAgentTargetProjection("codex", codexOAuthCatalog);
		expect(codex.files[0]?.content).toContain('model = "gpt-5.6-sol"');
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

	test("preserves opaque OpenClaw compat fields with explicit values taking precedence", () => {
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
							id: "k3",
							supports_tools: true,
							compat: { supportsDeveloperRole: false, supportsTools: false },
						},
						{
							id: "future-model",
							supports_tools: false,
							compat: { futureCompatibilityFlag: "preserved" },
						},
					],
				},
			],
			defaults: { chat_provider_id: "custom-main" },
		};

		const projection = buildAgentTargetProjection("openclaw", catalog);
		const patch = JSON.parse(projection.files[0]?.content ?? "{}") as {
			models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
		};
		const models = patch.models?.providers?.["custom-main"]?.models;
		expect(models?.[0]?.compat).toEqual({
			supportsDeveloperRole: false,
			supportsTools: false,
		});
		expect(models?.[1]?.compat).toEqual({
			supportsTools: false,
			futureCompatibilityFlag: "preserved",
		});
	});

	test("projects Sub2API overlay metadata without inventing a missing output cap", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				{
					id: CLAWDI_MANAGED_PROVIDER_ID,
					type: "custom_openai_compatible",
					base_url: "https://api.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_AI_API_KEY",
					models: [
						{ id: "k3", context_window: 1_048_576, max_input_tokens: 1_048_576 },
						{ id: "kimi-for-coding", context_window: 262_144, max_input_tokens: 262_144 },
						{
							id: "kimi-for-coding-highspeed",
							context_window: 262_144,
							max_input_tokens: 262_144,
						},
					],
				},
			],
			defaults: { chat_provider_id: CLAWDI_MANAGED_PROVIDER_ID },
		};

		const openclaw = buildAgentTargetProjection("openclaw", catalog, {
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
			model: "k3",
		});
		const openclawPatch = JSON.parse(openclaw.files[0]?.content ?? "{}") as {
			models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
		};
		const openclawModels =
			openclawPatch.models?.providers?.[CLAWDI_MANAGED_PROVIDER_ID]?.models ?? [];
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
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
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
					id: CLAWDI_MANAGED_PROVIDER_ID,
					type: "custom_openai_compatible",
					base_url: "https://api.example.test/v1",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_AI_API_KEY",
					models: [
						{
							id: "generic-output-alias",
							context_window: 400_000,
							max_input_tokens: 350_000,
							max_tokens: 16_384,
						},
					],
				},
			],
			defaults: { chat_provider_id: CLAWDI_MANAGED_PROVIDER_ID },
		};

		const primaryModel = {
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
			model: "generic-output-alias",
		};
		const openclaw = buildAgentTargetProjection("openclaw", catalog, primaryModel);
		const openclawPatch = JSON.parse(openclaw.files[0]?.content ?? "{}") as {
			models?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> };
		};
		expect(
			openclawPatch.models?.providers?.[CLAWDI_MANAGED_PROVIDER_ID]?.models?.[0],
		).toMatchObject({
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
