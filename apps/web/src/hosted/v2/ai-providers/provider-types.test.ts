import { describe, expect, test } from "bun:test";
import { API_MODE_LABEL, PROVIDER_TYPE_META } from "@/hosted/v2/ai-providers/provider-types";

describe("AI provider type metadata", () => {
	test("uses current model placeholders for known providers", () => {
		expect(PROVIDER_TYPE_META.openai.modelPlaceholder).toBe("gpt-5.6-sol");
		expect(PROVIDER_TYPE_META.anthropic.modelPlaceholder).toBe("claude-sonnet-5");
		expect(PROVIDER_TYPE_META.openrouter.modelPlaceholder).toBe("openrouter/auto-beta");
		expect(PROVIDER_TYPE_META.gemini.modelPlaceholder).toBe("gemini-3.6-flash");
		expect(PROVIDER_TYPE_META.mistral.modelPlaceholder).toBe("mistral-medium-latest");
	});

	test("uses canonical SDK environment variable names", () => {
		expect(PROVIDER_TYPE_META.openai.defaultRuntimeEnv).toBe("OPENAI_API_KEY");
		expect(PROVIDER_TYPE_META.anthropic.defaultRuntimeEnv).toBe("ANTHROPIC_API_KEY");
		expect(PROVIDER_TYPE_META.openrouter.defaultRuntimeEnv).toBe("OPENROUTER_API_KEY");
		expect(PROVIDER_TYPE_META.gemini.defaultRuntimeEnv).toBe("GEMINI_API_KEY");
		expect(PROVIDER_TYPE_META.mistral.defaultRuntimeEnv).toBe("MISTRAL_API_KEY");
	});

	test("links first-class providers to their API key pages", () => {
		expect(PROVIDER_TYPE_META.openai.apiKeyUrl).toBe(
			"https://platform.openai.com/settings/organization/api-keys",
		);
		expect(PROVIDER_TYPE_META.anthropic.apiKeyUrl).toBe(
			"https://platform.claude.com/settings/keys",
		);
		expect(PROVIDER_TYPE_META.openrouter.apiKeyUrl).toBe("https://openrouter.ai/keys");
		expect(PROVIDER_TYPE_META.gemini.apiKeyUrl).toBe("https://aistudio.google.com/apikey");
		expect(PROVIDER_TYPE_META.gemini.label).toBe("Google Gemini");
		expect(PROVIDER_TYPE_META.mistral.apiKeyUrl).toBe("https://console.mistral.ai/api-keys");
		expect(PROVIDER_TYPE_META.mistral.label).toBe("Mistral AI");
	});

	test("keeps shared catalog defaults aligned for models and API modes", () => {
		expect(PROVIDER_TYPE_META.openai.defaultApiMode).toBe("openai_responses");
		expect(PROVIDER_TYPE_META.openai.defaultModels.map((model) => model.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		expect(PROVIDER_TYPE_META.custom_openai_compatible.defaultModels).toEqual([]);
	});

	test("uses the factual protocol names shown in Advanced settings", () => {
		expect(API_MODE_LABEL).toEqual({
			openai_chat: "OpenAI Chat Completions",
			openai_responses: "OpenAI Responses",
			anthropic_messages: "Anthropic Messages",
			google_generate_content: "Gemini generateContent",
		});
	});
});
