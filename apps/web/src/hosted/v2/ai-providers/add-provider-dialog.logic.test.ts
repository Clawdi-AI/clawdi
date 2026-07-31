import { describe, expect, test } from "bun:test";
import {
	derivedProviderFields,
	modelsFromText,
	providerFormIdentity,
	providerListAllowsSubmit,
	shouldUseCatalogModels,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import {
	presetCatalogToProviderModels,
	providerPresetById,
	providerPresetForSavedProvider,
	providerPresetRegion,
	providerTypeForPreset,
} from "@/hosted/v2/ai-providers/provider-presets";

function testPreset(id: string) {
	const preset = providerPresetById(id);
	if (!preset) throw new Error(`Missing test preset: ${id}`);
	return preset;
}

describe("provider list submit gate", () => {
	test("blocks create until the provider list succeeds", () => {
		expect(providerListAllowsSubmit(false, false)).toBe(false);
		expect(providerListAllowsSubmit(false, true)).toBe(true);
	});

	test("does not block editing an already-loaded provider snapshot", () => {
		expect(providerListAllowsSubmit(true, false)).toBe(true);
	});
});

describe("providerFormIdentity", () => {
	test("keeps editing legacy mixed Kimi/Moonshot providers after retiring the preset", () => {
		expect(providerPresetById("kimi-moonshot")).toBeNull();
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "Kimi / Moonshot legacy",
				existingProviderIds: ["kimi-moonshot"],
				editing: {
					provider_id: "kimi-moonshot",
					label: "Kimi / Moonshot",
				},
			}),
		).toEqual({
			providerId: "kimi-moonshot",
			label: "Kimi / Moonshot legacy",
		});
	});

	test("derives a stable label and provider id for known providers", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "api_key",
				labelInput: "",
				existingProviderIds: [],
			}),
		).toEqual({
			providerId: "openai",
			label: "OpenAI",
		});
	});

	test("suffixes duplicate known providers instead of requiring a manual name", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "api_key",
				labelInput: "",
				existingProviderIds: ["openai", "openai-2"],
			}),
		).toEqual({
			providerId: "openai-3",
			label: "OpenAI 3",
		});
	});

	test("allocates an independent provider identity for every ChatGPT connection", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "oauth",
				labelInput: "",
				existingProviderIds: ["openai-codex", "openai-codex-2"],
			}),
		).toEqual({
			providerId: "openai-codex-3",
			label: "ChatGPT (Codex) 3",
		});
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "oauth",
				labelInput: "",
				existingProviderIds: [],
			}),
		).toEqual({
			providerId: "openai-codex",
			label: "ChatGPT (Codex)",
		});
	});

	test("preserves provider id while allowing label edits", () => {
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "Team proxy",
				existingProviderIds: ["team-proxy"],
				editing: {
					provider_id: "legacy-proxy",
					label: "Legacy proxy",
				},
			}),
		).toEqual({
			providerId: "legacy-proxy",
			label: "Team proxy",
		});
	});

	test("derives duplicate-safe ids and labels from presets", () => {
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "",
				existingProviderIds: ["deepseek"],
				preset: testPreset("deepseek"),
			}),
		).toEqual({
			providerId: "deepseek-2",
			label: "DeepSeek 2",
		});
	});

	test("uses optional names without changing preset-derived provider ids", () => {
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "Research DeepSeek",
				existingProviderIds: [],
				preset: testPreset("deepseek"),
			}),
		).toEqual({ providerId: "deepseek", label: "Research DeepSeek" });

		const kimi = testPreset("kimi-coding");
		expect(
			providerFormIdentity({
				type: providerTypeForPreset(kimi),
				authMethod: "api_key",
				labelInput: "Work Kimi",
				existingProviderIds: [],
				preset: kimi,
			}),
		).toEqual({ providerId: "kimi-coding", label: "Work Kimi" });

		const openrouter = testPreset("openrouter");
		expect(
			providerFormIdentity({
				type: providerTypeForPreset(openrouter),
				authMethod: "api_key",
				labelInput: "Team Router",
				existingProviderIds: ["openrouter"],
				preset: openrouter,
			}),
		).toEqual({ providerId: "openrouter-2", label: "Team Router" });
	});
});

describe("derivedProviderFields", () => {
	test("uses explicit protocol contracts for Kimi Code and Kimi API products", () => {
		const kimi = testPreset("kimi-coding");
		expect(kimi.label).toBe("Kimi Code");
		expect(kimi.catalog[0]?.alias).toBe("Kimi K2.7 Code");
		expect(providerTypeForPreset(kimi)).toBe("anthropic");
		expect(derivedProviderFields("anthropic", "api_key", kimi)).toEqual({
			baseUrl: "https://api.kimi.com/coding",
			apiMode: "anthropic_messages",
			runtimeEnv: "KIMI_CODING_API_KEY",
			modelsText: "kimi-for-coding",
			suggestedPrimaryModel: "kimi-for-coding",
		});

		const moonshot = testPreset("moonshot");
		expect(moonshot.label).toBe("Kimi API");
		expect(derivedProviderFields("custom_openai_compatible", "api_key", moonshot)).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
			apiMode: "openai_chat",
			modelsText: "kimi-k3",
			suggestedPrimaryModel: "kimi-k3",
		});
		expect(moonshot.region_variants).toEqual([
			{
				id: "cn",
				label: "China",
				base_url: "https://api.moonshot.cn/v1",
				api_key_url: "https://platform.kimi.com/console/api-keys",
			},
			{
				id: "global",
				label: "Global",
				base_url: "https://api.moonshot.ai/v1",
				api_key_url: "https://platform.kimi.ai/console/api-keys",
			},
		]);
		expect(providerPresetById("moonshot-cn")).toBeNull();
		expect(providerPresetById("moonshot-global")).toBeNull();
	});

	test("resolves saved providers only from canonical endpoints", () => {
		const moonshot = testPreset("moonshot");
		expect(providerPresetRegion(moonshot, "global")).toMatchObject({
			id: "global",
			base_url: "https://api.moonshot.ai/v1",
			api_key_url: "https://platform.kimi.ai/console/api-keys",
		});
		expect(
			providerPresetForSavedProvider({
				baseUrl: "https://api.moonshot.ai/v1",
			}),
		).toBe(moonshot);
		expect(
			providerPresetForSavedProvider({
				baseUrl: "https://api.deepseek.com/v1/",
			}),
		).toBe(testPreset("deepseek"));
		expect(
			providerPresetForSavedProvider({
				baseUrl: "https://proxy.example.com/v1",
			}),
		).toBeNull();
		expect(providerPresetRegion(testPreset("zhipu-glm"), "global")?.api_key_url).toBe(
			"https://z.ai/manage-apikey/apikey-list",
		);
		expect(providerPresetRegion(testPreset("stepfun"), "cn")?.base_url).toBe(
			"https://api.stepfun.com/v1",
		);
		expect(providerPresetRegion(testPreset("stepfun"), "global")?.api_key_url).toBe(
			"https://platform.stepfun.ai/interface-key",
		);
		expect(providerPresetRegion(testPreset("stepfun"), "cn")?.api_key_url).toBe(
			"https://platform.stepfun.com/interface-key",
		);
	});

	test("uses shared defaults for known providers", () => {
		expect(derivedProviderFields("openai", "api_key")).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai_responses",
			runtimeEnv: "OPENAI_API_KEY",
			modelsText: "gpt-5.5\ngpt-5.4\ngpt-5.4-mini",
		});
		expect(shouldUseCatalogModels("openai", "api_key")).toBe(true);
	});

	test("keeps officially documented xAI model context metadata", () => {
		const grok = testPreset("xai-grok");
		expect(grok.catalog.map((model) => model.id)).toEqual(["grok-4.5"]);
		expect(grok.catalog.find((model) => model.id === "grok-4.5")?.context_window).toBe(500_000);
	});

	test("keeps audited provider catalogs current", () => {
		expect(testPreset("deepseek").catalog.map((model) => model.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-pro",
		]);
		expect(testPreset("stepfun").catalog.map((model) => model.id)).toEqual(["step-3.7-flash"]);
		expect(testPreset("stepfun").catalog[0]?.context_window).toBeUndefined();
		expect(testPreset("openrouter").catalog.map((model) => model.id)).toEqual([
			"openrouter/auto-beta",
			"~openai/gpt-latest",
			"anthropic/claude-sonnet-5",
		]);
		expect(testPreset("together-ai").catalog.map((model) => model.id)).toEqual([
			"MiniMaxAI/MiniMax-M3",
			"zai-org/GLM-5.2",
		]);
		expect(testPreset("groq").catalog.map((model) => model.id)).toEqual(["openai/gpt-oss-120b"]);

		const zhipu = testPreset("zhipu-glm");
		expect(zhipu.catalog.find((model) => model.id === "glm-5.1")?.context_window).toBeUndefined();
		expect(zhipu.catalog.find((model) => model.id === "glm-4.7")?.context_window).toBeUndefined();
		expect(
			testPreset("minimax").catalog.find((model) => model.id === "MiniMax-M2")?.context_window,
		).toBeUndefined();

		const mistral = testPreset("mistral");
		expect(mistral.label).toBe("Mistral AI");
		expect(mistral.catalog.map((model) => [model.id, model.context_window])).toEqual([
			["mistral-large-latest", 256_000],
			["mistral-medium-latest", 256_000],
			["codestral-latest", 128_000],
		]);

		const gemini = testPreset("google-gemini-openai");
		expect(gemini.catalog.map((model) => [model.id, model.context_window])).toEqual([
			["gemini-3.5-flash", 1_048_576],
			["gemini-2.5-pro", 1_048_576],
		]);
	});

	test("uses the Codex catalog for ChatGPT sign-in", () => {
		expect(derivedProviderFields("openai", "oauth")).toEqual({
			baseUrl: "https://api.openai.com/v1",
			apiMode: "openai_responses",
			runtimeEnv: "OPENAI_API_KEY",
			modelsText: "gpt-5.5\ngpt-5.4\ngpt-5.3-codex\ngpt-5.4-mini",
		});
		expect(shouldUseCatalogModels("openai", "oauth")).toBe(true);
	});

	test("leaves custom providers empty until the user fills advanced fields", () => {
		expect(derivedProviderFields("custom_openai_compatible", "api_key")).toEqual({
			baseUrl: "",
			apiMode: "openai_chat",
			runtimeEnv: "CUSTOM_API_KEY",
			modelsText: "",
		});
		expect(shouldUseCatalogModels("custom_openai_compatible", "api_key")).toBe(false);
	});

	test("uses preset fields for BYOK provider presets", () => {
		const preset = testPreset("deepseek");

		expect(derivedProviderFields("custom_openai_compatible", "api_key", preset)).toEqual({
			baseUrl: "https://api.deepseek.com/v1",
			apiMode: "openai_chat",
			runtimeEnv: "DEEPSEEK_API_KEY",
			modelsText: "deepseek-v4-flash\ndeepseek-v4-pro",
			suggestedPrimaryModel: "deepseek-v4-flash",
		});
		expect(shouldUseCatalogModels("custom_openai_compatible", "api_key", preset)).toBe(true);
	});
});

describe("modelsFromText", () => {
	test("deduplicates model ids while preserving known metadata", () => {
		expect(
			modelsFromText("gpt-5.5\ngpt-5.4\ngpt-5.5", [
				{ id: "gpt-5.4", label: "GPT-5.4" },
				{ id: "gpt-5.5", label: "GPT-5.5" },
			]),
		).toEqual([
			{ id: "gpt-5.5", label: "GPT-5.5" },
			{ id: "gpt-5.4", label: "GPT-5.4" },
		]);
	});

	test("builds preset request models with catalog metadata", () => {
		const preset = testPreset("deepseek");

		expect(
			modelsFromText(
				"deepseek-v4-flash\nunknown-model\ndeepseek-v4-flash",
				null,
				presetCatalogToProviderModels(preset),
			),
		).toEqual([
			{
				id: "deepseek-v4-flash",
				label: "DeepSeek V4 Flash",
				alias: "DeepSeek V4 Flash",
				context_window: 1_000_000,
			},
			{ id: "unknown-model" },
		]);
	});
});
