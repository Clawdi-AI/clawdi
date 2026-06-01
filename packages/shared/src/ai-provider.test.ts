import { describe, expect, test } from "bun:test";
import { isProviderAuthProfileId, validateAiProviderCatalog } from "./ai-provider";

describe("validateAiProviderCatalog", () => {
	test("returns validation errors instead of throwing for malformed catalog entries", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				null,
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					models: { id: "gpt-5.2" },
				},
				{
					id: "openai-alt",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					auth: { type: "secret_ref" },
					models: [{ id: "gpt-5.2", context_window: "large" }],
				},
			],
		} as never);

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Provider entry must be an object.");
		expect(result.errors).toContain("Provider openai-main auth must be an object.");
		expect(result.errors).toContain("Provider openai-main models must be an array.");
		expect(result.errors).toContain("Provider openai-alt has unsupported secret ref.");
		expect(result.errors).toContain(
			"Provider openai-alt model gpt-5.2 has invalid context_window.",
		);
	});

	test("rejects auth profiles and payload refs that do not match the provider", () => {
		expect(isProviderAuthProfileId("default")).toBe(true);
		expect(isProviderAuthProfileId("team/default")).toBe(false);

		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					auth: {
						type: "api_key",
						source: "managed",
						payload_ref: "ai-provider-auth://other/default",
					},
				},
				{
					id: "openai-agent",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					auth: {
						type: "agent_profile",
						tool: "codex",
						profile: "team/default",
						payload_ref: "ai-provider-auth://openai-agent/default",
					},
				},
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Provider openai-main api_key auth has invalid payload_ref.");
		expect(result.errors).toContain(
			"Provider openai-agent has invalid agent_profile auth metadata.",
		);
	});
});
