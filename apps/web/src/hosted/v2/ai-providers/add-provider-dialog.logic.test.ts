import { describe, expect, test } from "bun:test";
import {
	customProviderRuntimeEnv,
	derivedProviderFields,
	providerFormIdentity,
	providerListAllowsSubmit,
	providerSettingsPatch,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import { providerPresetSummary } from "@/hosted/v2/ai-providers/model-binding";
import {
	providerPresetById,
	providerPresetForSavedProvider,
	providerPresetRegion,
} from "@/hosted/v2/ai-providers/provider-presets";

function testPreset(id: string) {
	const preset = providerPresetById(id);
	if (!preset) throw new Error(`Missing test preset: ${id}`);
	return preset;
}

test("new custom credentials avoid existing normalized environment names", () => {
	expect(customProviderRuntimeEnv("ai", [])).toBe("CLAWDI_AI_API_KEY_2");
	expect(
		customProviderRuntimeEnv("team.gateway", [{ runtime_env_name: "CLAWDI_TEAM_GATEWAY_API_KEY" }]),
	).toBe("CLAWDI_TEAM_GATEWAY_API_KEY_2");
});

test("renaming a legacy provider does not materialize its implicit API format", () => {
	expect(
		providerSettingsPatch(
			{
				type: "openai",
				base_url: "https://api.openai.com/v1",
				api_mode: null,
				auth: { type: "api_key", source: "managed" },
			},
			{
				label: "Work account",
				base_url: "https://api.openai.com/v1",
				api_mode: "openai_responses",
			},
		),
	).toEqual({ label: "Work account" });
});

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
	test("allows display names independently of provider IDs", () => {
		expect(
			providerFormIdentity({
				type: "openai",
				authMethod: "api_key",
				labelInput: "Work account",
				existingProviderIds: [],
			}),
		).toEqual({ providerId: "openai", label: "Work account" });
		expect(
			providerFormIdentity({
				type: "custom_openai_compatible",
				authMethod: "api_key",
				labelInput: "团队模型",
				existingProviderIds: ["custom"],
			}),
		).toEqual({ providerId: "custom-2", label: "团队模型" });
	});
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
				type: kimi.provider_type,
				authMethod: "api_key",
				labelInput: "Work Kimi",
				existingProviderIds: [],
				preset: kimi,
			}),
		).toEqual({ providerId: "kimi-coding", label: "Work Kimi" });

		const openrouter = testPreset("openrouter");
		expect(
			providerFormIdentity({
				type: openrouter.provider_type,
				authMethod: "api_key",
				labelInput: "Team Router",
				existingProviderIds: ["openrouter"],
				preset: openrouter,
			}),
		).toEqual({ providerId: "openrouter-2", label: "Team Router" });
	});
});

describe("native provider form defaults", () => {
	test("preserves region and plan choices without asking for endpoint details", () => {
		const preset = testPreset("qwen-dashscope");
		const region = providerPresetRegion(preset, "coding-global");
		expect(region?.id).toBe("coding-global");
		expect(region?.base_url.startsWith("https://")).toBe(true);
		expect(providerPresetSummary(preset)).toBe("API key · region / plan options");
		expect(providerPresetForSavedProvider({ baseUrl: preset.base_url })?.id).toBe(preset.id);
	});

	test("keeps custom endpoint input empty", () => {
		expect(derivedProviderFields("custom_openai_compatible", "api_key")).toEqual({
			baseUrl: "",
			apiMode: "openai_chat",
		});
	});
});
