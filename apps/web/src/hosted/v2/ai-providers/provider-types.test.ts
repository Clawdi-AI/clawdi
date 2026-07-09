import { describe, expect, test } from "bun:test";
import { PROVIDER_TYPE_META } from "@/hosted/v2/ai-providers/provider-types";

describe("AI provider type metadata", () => {
	test("uses current model placeholders for known providers", () => {
		expect(PROVIDER_TYPE_META.openai.modelPlaceholder).toBe("gpt-5.5");
		expect(PROVIDER_TYPE_META.anthropic.modelPlaceholder).toBe("claude-sonnet-5");
		expect(PROVIDER_TYPE_META.openrouter.modelPlaceholder).toBe("anthropic/claude-sonnet-5");
		expect(PROVIDER_TYPE_META.gemini.modelPlaceholder).toBe("gemini-2.5-pro");
		expect(PROVIDER_TYPE_META.mistral.modelPlaceholder).toBe("mistral-large-latest");
	});

	test("uses canonical SDK environment variable names", () => {
		expect(PROVIDER_TYPE_META.openai.defaultRuntimeEnv).toBe("OPENAI_API_KEY");
		expect(PROVIDER_TYPE_META.anthropic.defaultRuntimeEnv).toBe("ANTHROPIC_API_KEY");
		expect(PROVIDER_TYPE_META.openrouter.defaultRuntimeEnv).toBe("OPENROUTER_API_KEY");
		expect(PROVIDER_TYPE_META.gemini.defaultRuntimeEnv).toBe("GEMINI_API_KEY");
		expect(PROVIDER_TYPE_META.mistral.defaultRuntimeEnv).toBe("MISTRAL_API_KEY");
	});

	test("keeps shared catalog defaults aligned for models and API modes", () => {
		expect(PROVIDER_TYPE_META.openai.defaultApiMode).toBe("openai_responses");
		expect(PROVIDER_TYPE_META.openai.defaultModels.map((model) => model.id)).toEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
		]);
		expect(PROVIDER_TYPE_META.custom_openai_compatible.defaultModels).toEqual([]);
	});
});
