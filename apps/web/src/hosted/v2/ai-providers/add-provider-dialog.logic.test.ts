import { describe, expect, test } from "bun:test";
import {
	derivedProviderFields,
	modelsFromText,
	providerFormIdentity,
	providerListAllowsSubmit,
	runPostSaveProviderConnectionTest,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import { providerPresetSummary } from "@/hosted/v2/ai-providers/model-binding";
import {
	PROVIDER_PRESETS,
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

describe("post-save provider connection test", () => {
	test("does not send inference when native credentials are saved", async () => {
		let called = false;
		const result = await runPostSaveProviderConnectionTest(
			{
				provider_id: "openai",
				configuration_mode: "native",
				models: null,
				auth: { type: "api_key", source: "managed" },
			},
			async () => {
				called = true;
				return { ok: true, error: null };
			},
		);
		expect(called).toBe(false);
		expect(result).toBeNull();
	});

	test("tests a saved managed API key against its first model", async () => {
		const inputs: unknown[] = [];
		const result = await runPostSaveProviderConnectionTest(
			{
				provider_id: "openai",
				auth: { type: "api_key", source: "managed" },
				models: [{ id: "gpt-5" }],
			},
			async (input) => {
				inputs.push(input);
				return { ok: true, error: null };
			},
		);

		expect(inputs).toEqual([
			{
				params: { path: { provider_id: "openai" } },
				body: { model: "gpt-5" },
			},
		]);
		expect(result?.ok).toBe(true);
	});

	test("keeps a successful save authoritative when its follow-up test fails", async () => {
		const result = await runPostSaveProviderConnectionTest(
			{
				provider_id: "openai",
				auth: { type: "api_key", source: "managed" },
				models: null,
			},
			async () => {
				throw new Error("offline");
			},
		);

		expect(result).toBeNull();
	});

	test("does not run the API-key test for OAuth providers", async () => {
		let called = false;
		const result = await runPostSaveProviderConnectionTest(
			{
				provider_id: "openai-codex",
				auth: { type: "agent_profile", tool: "codex", profile: "default" },
				models: [{ id: "gpt-5" }],
			},
			async () => {
				called = true;
				return { ok: true, error: null };
			},
		);

		expect(called).toBe(false);
		expect(result).toBeNull();
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

describe("native provider form defaults", () => {
	test("leaves model selection to the agent for every native choice", () => {
		for (const preset of PROVIDER_PRESETS) {
			expect(
				derivedProviderFields(providerTypeForPreset(preset), "api_key", preset).modelsText,
			).toBe("");
			expect(preset).not.toHaveProperty("catalog");
		}
		expect(derivedProviderFields("openai", "api_key").modelsText).toBe("");
		expect(derivedProviderFields("openai", "oauth").modelsText).toBe("");
	});

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
			runtimeEnv: "CUSTOM_API_KEY",
			modelsText: "",
		});
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
});
