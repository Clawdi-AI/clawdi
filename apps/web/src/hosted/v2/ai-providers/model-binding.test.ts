import { describe, expect, test } from "bun:test";
import {
	firstModelForProvider,
	MANAGED_AI_CHOICE,
	MANAGED_DEFAULT_MODEL_CHOICE,
	managedModelDisplayName,
	modelIdsForProvider,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

describe("model binding", () => {
	test("uses an explicit hosted-default choice without guessing a model id", () => {
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe(MANAGED_DEFAULT_MODEL_CHOICE);
		expect(modelIdsForProvider(MANAGED_AI_CHOICE, [])).toEqual([MANAGED_DEFAULT_MODEL_CHOICE]);
	});

	test("puts the hosted default before the v2 managed catalog and uses friendly names", () => {
		const managedModels = [
			{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true },
			{ id: "gpt-5.6-sol", display_name: "Sol", is_default: false },
		];

		expect(modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels)).toEqual([
			MANAGED_DEFAULT_MODEL_CHOICE,
			"gpt-5.6-luna",
			"gpt-5.6-sol",
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
});
