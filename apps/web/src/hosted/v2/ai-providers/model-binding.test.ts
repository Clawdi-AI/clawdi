import { describe, expect, test } from "bun:test";
import {
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	managedModelDisplayName,
	managedModelPickerItems,
	modelIdsForProvider,
	providerChoiceFromRef,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

describe("model binding", () => {
	test("does not invent a managed model before the catalog loads", () => {
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe("");
		expect(modelIdsForProvider(MANAGED_AI_CHOICE, [])).toEqual([]);
	});

	test("puts the catalog default first and exposes real managed model names", () => {
		const managedModels = [
			{ id: "gpt-5.6-sol", display_name: "Sol", is_default: false },
			{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true },
			{ id: "gpt-5.6-terra", display_name: "Terra", is_default: false },
		];

		expect(modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels)).toEqual([
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [], managedModels)).toBe("gpt-5.6-luna");
		expect(
			modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels).map((modelId) =>
				managedModelDisplayName(modelId, managedModels),
			),
		).toEqual(["Luna", "Sol", "Terra"]);
		expect(managedModelPickerItems(managedModels)).toEqual([
			{ value: "gpt-5.6-luna", label: "Luna" },
			{ value: "gpt-5.6-sol", label: "Sol" },
			{ value: "gpt-5.6-terra", label: "Terra" },
		]);
		expect(managedModelDisplayName("gpt-5.6-sol", managedModels)).toBe("Sol");
	});

	test("uses the first catalog model for a selected provider", () => {
		const providers = [
			{
				id: "row-openai",
				provider_id: "openai-main",
				scope: "account_global",
				type: "openai",
				base_url: "https://api.openai.com/v1",
				models: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }],
				api_mode: "openai_responses",
				auth: { type: "api_key", source: "managed" },
				managed_by: "user",
				runtime_env_name: "OPENAI_API_KEY",
				capabilities: null,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
				label: "OpenAI",
			} satisfies AiProvider,
		];

		expect(firstModelForProvider("openai-main", providers)).toBe("gpt-5.5");
	});

	test("maps deployment-scoped managed provider ids to the friendly managed choice", () => {
		const providerId = "clawdi-v2-deployment-10";
		expect(isManagedProviderId(providerId)).toBe(true);
		expect(providerChoiceFromRef(providerId, [])).toBe(MANAGED_AI_CHOICE);
	});
});
