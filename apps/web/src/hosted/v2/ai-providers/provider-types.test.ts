import { describe, expect, test } from "bun:test";
import { PROVIDER_TYPE_META } from "@/hosted/v2/ai-providers/provider-types";

describe("AI provider type metadata", () => {
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
		expect(PROVIDER_TYPE_META.mistral.apiKeyUrl).toBe("https://console.mistral.ai/api-keys");
	});
});
