import { describe, expect, test } from "bun:test";
import {
	type AiProviderAuth,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_PROVIDER_ID,
	CODEX_OAUTH_MODEL_CATALOG,
	defaultAiProviderModels,
	defaultAiProviderRuntimeEnvName,
	isFirstPartyManagedAiProvider,
	isProviderAuthProfileId,
	validateAiProviderCatalog,
} from "./ai-provider";
import type { components } from "./api/api.generated";

type GeneratedAiProviderAuth = components["schemas"]["AiProviderAuth"];

function sharedAuthToGenerated(auth: AiProviderAuth): GeneratedAiProviderAuth {
	return auth;
}

function generatedAuthToShared(auth: GeneratedAiProviderAuth): AiProviderAuth {
	return auth;
}

describe("validateAiProviderCatalog", () => {
	test("keeps the shared auth union aligned with the generated API union", () => {
		const auth = {
			type: "api_key",
			source: "managed",
			profile: "work_team",
		} satisfies AiProviderAuth;

		expect(generatedAuthToShared(sharedAuthToGenerated(auth))).toEqual(auth);
	});

	test.each([
		{ type: "secret_ref", ref: "env:OPENAI_API_KEY" },
		{ type: "api_key", source: "env", ref: "env:OPENAI_API_KEY" },
		{
			type: "api_key",
			source: "vault",
			ref: "clawdi://providers/openai",
			profile: "work_team",
		},
		{ type: "api_key", source: "managed", profile: "personal" },
		{ type: "oauth_profile", provider: "codex", profile: "default" },
		{ type: "agent_profile", tool: "codex", profile: "default" },
		{ type: "none" },
	] satisfies AiProviderAuth[])("accepts strict auth variant %#", (auth) => {
		const result = validateAiProviderCatalog(
			{
				schema_version: 1,
				providers: [
					{
						id: "auth-conformance",
						type: "custom_openai_compatible",
						base_url: "http://127.0.0.1:1234/v1",
						api_mode: "openai_chat",
						auth,
					},
				],
			},
			{ allowNoAuthPublic: false },
		);

		expect(result.errors).toEqual([]);
	});

	test.each([
		{ type: "secret_ref", ref: "env:OPENAI_API_KEY", source: "env" },
		{ type: "api_key", source: "managed", ref: "env:OPENAI_API_KEY" },
		{ type: "api_key", source: "managed", profiel: "default" },
		{ type: "agent_profile", tool: "codex", profile: "default", ref: "env:KEY" },
		{ type: "none", profile: "default" },
	])("rejects extra or cross-variant auth field %#", (auth) => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "auth-conformance",
					type: "custom_openai_compatible",
					base_url: "http://127.0.0.1:1234/v1",
					api_mode: "openai_chat",
					auth,
				},
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.includes("unexpected field"))).toBe(true);
	});

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
					models: [{ id: "gpt-5.2", context_window: "large", supports_tools: "yes" }],
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
		expect(result.errors).toContain(
			"Provider openai-alt model gpt-5.2 has invalid supports_tools.",
		);
	});

	test("accepts model alias and cost metadata", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "openai-main",
					type: "openai",
					base_url: "https://api.openai.com/v1",
					auth: { type: "api_key", source: "env", ref: "env:OPENAI_API_KEY" },
					models: [
						{
							id: "gpt-5.5",
							alias: "GPT-5.5",
							cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
						},
					],
				},
			],
		});

		expect(result.valid).toBe(true);
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
		} as never);

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

	test("rejects Codex Responses as a provider API mode", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "custom-openai",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					models: [{ id: "gpt-5.5" }],
					api_mode: "codex_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "user",
					runtime_env_name: "CUSTOM_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "custom-openai" },
		} as never);

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			'Provider custom-openai has invalid api_mode "codex_responses".',
		);
	});

	test("rejects legacy OpenAI Codex model refs", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "custom-openai",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					api_mode: "openai_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "user",
					runtime_env_name: "CUSTOM_OPENAI_API_KEY",
					models: [{ id: "openai-codex/gpt-5.5" }],
				},
			],
			defaults: { chat_provider_id: "custom-openai" },
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Provider custom-openai model openai-codex/gpt-5.5 must use the OpenAI model id without the legacy openai-codex prefix.",
		);
	});

	test("accepts v2 Clawdi-managed providers in OpenAI chat mode", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed-v2",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					models: [{ id: "gpt-5.5" }],
					api_mode: "openai_chat",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed-v2" },
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("accepts v1 Clawdi-managed providers in OpenAI responses mode", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					models: [{ id: "gpt-5.5" }],
					api_mode: "openai_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed" },
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("requires v2 Clawdi-managed providers to use OpenAI chat mode", () => {
		const result = validateAiProviderCatalog({
			schema_version: 1,
			providers: [
				{
					id: "clawdi-managed-v2",
					type: "custom_openai_compatible",
					base_url: "https://managed.example/v1",
					models: [{ id: "gpt-5.5" }],
					api_mode: "openai_responses",
					auth: { type: "api_key", source: "managed" },
					managed_by: "clawdi",
					runtime_env_name: "CLAWDI_MANAGED_OPENAI_API_KEY",
				},
			],
			defaults: { chat_provider_id: "clawdi-managed-v2" },
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"Provider clawdi-managed-v2 managed_by clawdi must use api_mode openai_chat.",
		);
	});
});

describe("isFirstPartyManagedAiProvider", () => {
	test("matches first-party managed ids even when old rows are missing managed_by", () => {
		expect(isFirstPartyManagedAiProvider({ provider_id: CLAWDI_MANAGED_V1_PROVIDER_ID })).toBe(
			true,
		);
		expect(isFirstPartyManagedAiProvider({ provider_id: CLAWDI_MANAGED_V2_PROVIDER_ID })).toBe(
			true,
		);
	});

	test("matches managed_by clawdi for current rows", () => {
		expect(isFirstPartyManagedAiProvider({ provider_id: "custom", managed_by: "clawdi" })).toBe(
			true,
		);
	});

	test("does not match user providers", () => {
		expect(isFirstPartyManagedAiProvider({ provider_id: "openai-prod", managed_by: "user" })).toBe(
			false,
		);
	});
});

describe("known AI provider defaults", () => {
	test("exposes runtime env defaults for built-in providers", () => {
		expect(defaultAiProviderRuntimeEnvName("openai")).toBe("OPENAI_API_KEY");
		expect(defaultAiProviderRuntimeEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
		expect(defaultAiProviderRuntimeEnvName("openrouter")).toBe("OPENROUTER_API_KEY");
		expect(defaultAiProviderRuntimeEnvName("gemini")).toBe("GEMINI_API_KEY");
		expect(defaultAiProviderRuntimeEnvName("mistral")).toBe("MISTRAL_API_KEY");
		expect(defaultAiProviderRuntimeEnvName("custom_openai_compatible")).toBeUndefined();
	});

	test("provides a non-empty model catalog for built-in providers and Codex OAuth", () => {
		expect(defaultAiProviderModels("openai").map((model) => model.id)).toEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
		]);
		expect(defaultAiProviderModels("anthropic").map((model) => model.id)).toEqual([
			"claude-sonnet-5",
			"claude-opus-4-6",
			"claude-haiku-4-5",
		]);
		expect(defaultAiProviderModels("custom_openai_compatible")).toEqual([]);
		expect(CODEX_OAUTH_MODEL_CATALOG.map((model) => model.id)).toEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.3-codex",
			"gpt-5.4-mini",
		]);
	});
});
