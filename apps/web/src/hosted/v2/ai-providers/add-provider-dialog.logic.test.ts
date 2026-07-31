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
});

describe("derivedProviderFields", () => {
	test("uses explicit protocol contracts for Kimi Coding and Moonshot products", () => {
		const kimi = testPreset("kimi-coding");
		expect(providerTypeForPreset(kimi)).toBe("anthropic");
		expect(derivedProviderFields("anthropic", "api_key", kimi)).toEqual({
			baseUrl: "https://api.kimi.com/coding",
			apiMode: "anthropic_messages",
			runtimeEnv: "KIMI_CODING_API_KEY",
			modelsText: "kimi-for-coding",
			suggestedPrimaryModel: "kimi-for-coding",
		});

		const moonshot = testPreset("moonshot");
		expect(derivedProviderFields("custom_openai_compatible", "api_key", moonshot)).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
			apiMode: "openai_chat",
			modelsText: "moonshot-v1-128k",
		});
		expect(moonshot.region_variants).toEqual([
			{
				id: "cn",
				label: "China",
				base_url: "https://api.moonshot.cn/v1",
				api_key_url: "https://platform.moonshot.cn/console/api-keys",
				website_url: "https://platform.moonshot.cn",
			},
			{
				id: "global",
				label: "Global",
				base_url: "https://api.moonshot.ai/v1",
				api_key_url: "https://platform.moonshot.ai/console/api-keys",
				website_url: "https://platform.moonshot.ai",
			},
		]);
		expect(providerPresetById("moonshot-cn")).toBeNull();
		expect(providerPresetById("moonshot-global")).toBeNull();
	});

	test("resolves saved providers and region-specific endpoint links", () => {
		const moonshot = testPreset("moonshot");
		expect(providerPresetRegion(moonshot, "global")).toMatchObject({
			id: "global",
			base_url: "https://api.moonshot.ai/v1",
			api_key_url: "https://platform.moonshot.ai/console/api-keys",
		});
		expect(
			providerPresetForSavedProvider({
				providerId: "moonshot-2",
				baseUrl: "https://api.moonshot.ai/v1",
			}),
		).toBe(moonshot);
		expect(providerPresetRegion(testPreset("zhipu-glm"), "global")?.api_key_url).toBe(
			"https://z.ai/manage-apikey/apikey-list",
		);
		expect(providerPresetRegion(testPreset("stepfun"), "cn")?.base_url).toBe(
			"https://api.stepfun.com/v1",
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
			modelsText: "deepseek-v4-flash\ndeepseek-v4",
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
