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

	test("rejects malformed auth profile metadata", () => {
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
						ref: "env:OPENAI_API_KEY",
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
					},
				},
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Provider openai-main api_key auth with source managed must not include ref.",
		);
		expect(result.errors).toContain(
			"Provider openai-agent has invalid agent_profile auth metadata.",
		);
	});

	test("allows no-auth local endpoints but rejects public no-auth URLs", () => {
		for (const base_url of [
			"http://localhost:1234/v1",
			"http://127.0.0.1:1234/v1",
			"http://[::1]:1234/v1",
			"http://0.0.0.0:1234/v1",
		]) {
			const result = validateAiProviderCatalog({
				schema_version: 1,
				providers: [
					{
						id: "local-main",
						type: "custom_openai_compatible",
						base_url,
						api_mode: "openai_chat",
						auth: { type: "none" },
					},
				],
			});

			expect(result.errors).toEqual([]);
			expect(result.valid).toBe(true);
		}

		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "public-main",
					type: "custom_openai_compatible",
					base_url: "https://example.com/v1",
					api_mode: "openai_chat",
					auth: { type: "none" },
				},
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Provider public-main uses no auth on a public URL.");
	});

	test("accepts Codex Responses mode for user custom OpenAI-compatible providers", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "custom-openai",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					default_model: "openai-codex/gpt-5.5",
					api_mode: "codex_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "user",
					runtime_env_name: "CUSTOM_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "custom-openai" },
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("requires Clawdi-managed providers to use OpenAI Responses mode", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					default_model: "openai-codex/gpt-5.5",
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed" },
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Provider clawdi-managed managed_by clawdi must use api_mode openai_responses.",
		);
	});
});
