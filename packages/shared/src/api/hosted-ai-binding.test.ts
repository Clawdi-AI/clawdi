import { describe, expect, test } from "bun:test";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_DEPLOYMENT_PROVIDER_PREFIX,
	CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID,
	CLAWDI_MANAGED_V2_LEGACY_PUBLIC_PROVIDER_ID,
} from "../ai-provider";
import {
	buildHostedAiBindingFields,
	HostedAiBindingError,
	type HostedSavedAiProvider,
} from "./hosted-ai-binding";

const managedModels = [
	{
		id: "gpt-managed",
		display_name: "Managed",
		provider_id: "openai-codex",
		is_default: true,
		is_featured: true,
		description: null,
		capabilities: {
			context_window: 128_000,
			max_context_window: null,
			max_input_tokens: 128_000,
			max_output_tokens: null,
			input_modalities: ["text" as const],
			supports_vision: false,
			supports_reasoning: null,
			supports_tools: null,
		},
	},
];

const apiKeyProvider = {
	id: "row-api",
	provider_id: "openai-main",
	scope: "user",
	type: "openai",
	label: "OpenAI",
	base_url: "https://api.openai.com/v1",
	api_mode: "openai_responses",
	managed_by: "user",
	runtime_env_name: "OPENAI_API_KEY",
	capabilities: { chat: true, responses: true },
	models: [
		{
			id: "gpt-catalog",
			supports_vision: true,
			supports_tools: false,
			max_input_tokens: 120_000,
			compat: { supportsDeveloperRole: false, future: { opaque: true } },
		},
	],
	auth: { type: "api_key", source: "managed", profile: "work" },
	usable: true,
	readiness: {
		credential_material: "available",
		runtime_compatibility: { openclaw: true, hermes: true, codex: true },
		deployable: true,
		endpoint_reachability: "not_tested",
		inference_verification: "not_tested",
	},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
} satisfies HostedSavedAiProvider;

const codexProvider = {
	...apiKeyProvider,
	id: "row-codex",
	provider_id: "codex-main",
	label: "Codex",
	models: [{ id: "gpt-codex" }],
	auth: { type: "agent_profile", tool: "codex", profile: "default" },
} satisfies HostedSavedAiProvider;

const noncanonicalManagedProviders: HostedSavedAiProvider[] = [
	{ ...apiKeyProvider, id: "row-v1", provider_id: CLAWDI_MANAGED_V1_PROVIDER_ID },
	{
		...apiKeyProvider,
		id: "row-legacy-public",
		provider_id: CLAWDI_MANAGED_V2_LEGACY_PUBLIC_PROVIDER_ID,
	},
	{
		...apiKeyProvider,
		id: "row-legacy",
		provider_id: CLAWDI_MANAGED_V2_LEGACY_PROVIDER_ID,
	},
	{
		...apiKeyProvider,
		id: "row-deployment",
		provider_id: `${CLAWDI_MANAGED_V2_DEPLOYMENT_PROVIDER_PREFIX}42`,
	},
	{
		...apiKeyProvider,
		id: "row-managed-by",
		provider_id: "custom-managed-id",
		managed_by: "clawdi",
	},
];

describe("shared Hosted AI provider binding", () => {
	test("builds the same managed and unmanaged deployment fields for every adapter", () => {
		expect(
			buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [],
				selection: { mode: "managed", model: "gpt-managed" },
			}),
		).toEqual({
			ai_provider_auth_kind: "managed",
			ai_provider_id: null,
			provider_ids: [CLAWDI_MANAGED_PROVIDER_ID],
			primary_model: { provider_id: CLAWDI_MANAGED_PROVIDER_ID, model: "gpt-managed" },
		});
		expect(
			buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [],
				selection: { mode: "unmanaged" },
			}),
		).toEqual({ ai_provider_auth_kind: "unmanaged" });
	});

	test("binds a saved API-key provider with catalog and custom models", () => {
		for (const model of ["gpt-catalog", "org/private-custom-model"]) {
			const fields = buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [apiKeyProvider],
				selection: {
					mode: "saved",
					providerId: apiKeyProvider.provider_id,
					model,
				},
			});
			expect(fields).toMatchObject({
				ai_provider_auth_kind: "api_key",
				ai_provider_id: "openai-main",
				provider_ids: ["openai-main"],
				primary_model: { provider_id: "openai-main", model },
				ai_provider_bootstrap: {
					schema_version: 1,
					selected_provider_id: "openai-main",
					auth_kind: "api_key",
					catalog: {
						schema_version: 1,
						defaults: { chat_provider_id: "openai-main" },
					},
				},
			});
			expect(Object.keys(fields.ai_provider_bootstrap ?? {}).sort()).toEqual([
				"auth_kind",
				"catalog",
				"schema_version",
				"selected_provider_id",
			]);
			expect(fields.ai_provider_bootstrap?.catalog.providers[0]?.auth).toEqual({
				type: "api_key",
				source: "managed",
				profile: "work",
			});
			expect(fields.ai_provider_bootstrap?.catalog.providers[0]?.models?.[0]).toEqual({
				id: "gpt-catalog",
				supports_vision: true,
				supports_tools: false,
				max_input_tokens: 120_000,
				compat: { supportsDeveloperRole: false, future: { opaque: true } },
			});
		}
	});

	test("binds a saved Codex OAuth profile without credential material", () => {
		const fields = buildHostedAiBindingFields({
			managedModels,
			mode: "create",
			providers: [codexProvider],
			selection: {
				mode: "saved",
				providerId: codexProvider.provider_id,
				model: "gpt-codex",
			},
		});
		expect(fields.ai_provider_auth_kind).toBe("codex_oauth");
		expect(fields.ai_provider_bootstrap?.auth_kind).toBe("codex_oauth");
		expect(fields.ai_provider_bootstrap?.catalog.providers[0]?.auth).toEqual({
			type: "agent_profile",
			tool: "codex",
			profile: "default",
		});
		expect(JSON.stringify(fields)).not.toContain("refresh_token");
		expect(JSON.stringify(fields)).not.toContain("api_key_value");
	});

	test("rejects canonical managed provider as a saved selection with or without its row", () => {
		const canonicalManagedProvider = {
			...apiKeyProvider,
			id: "row-managed-v2",
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
			managed_by: "clawdi",
		} satisfies HostedSavedAiProvider;

		for (const providers of [[], [canonicalManagedProvider]]) {
			try {
				buildHostedAiBindingFields({
					managedModels,
					mode: "create",
					providers,
					selection: {
						mode: "saved",
						providerId: CLAWDI_MANAGED_PROVIDER_ID,
						model: "gpt-catalog",
					},
				});
				throw new Error("Expected canonical managed provider primary to be rejected.");
			} catch (error) {
				expect(error).toBeInstanceOf(HostedAiBindingError);
				if (!(error instanceof HostedAiBindingError)) throw error;
				expect(error.code).toBe("first_party_managed_provider");
			}
		}
	});

	test("rejects noncanonical first-party managed providers as saved selections", () => {
		for (const provider of noncanonicalManagedProviders) {
			try {
				buildHostedAiBindingFields({
					managedModels,
					mode: "create",
					providers: [provider],
					selection: {
						mode: "saved",
						providerId: provider.provider_id,
						model: "gpt-catalog",
					},
				});
				throw new Error(`Expected ${provider.provider_id} to be rejected.`);
			} catch (error) {
				expect(error).toBeInstanceOf(HostedAiBindingError);
				if (!(error instanceof HostedAiBindingError)) throw error;
				expect(error.code).toBe("first_party_managed_provider");
			}
		}
	});

	test("rejects missing, unusable, and unknown managed selections", () => {
		const buildSaved = (providers: readonly HostedSavedAiProvider[]) =>
			buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers,
				selection: {
					mode: "saved",
					providerId: apiKeyProvider.provider_id,
					model: "gpt-catalog",
				},
			});
		expect(() => buildSaved([])).toThrow("is unavailable");
		expect(() =>
			buildSaved([
				{
					...apiKeyProvider,
					usable: false,
					readiness: { ...apiKeyProvider.readiness, deployable: false },
				},
			]),
		).toThrow("cannot deliver its credential");
		expect(() => buildSaved([{ ...apiKeyProvider, readiness: undefined }])).toThrow(
			"has no Hosted readiness metadata",
		);
		expect(() =>
			buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [],
				selection: { mode: "managed", model: "not-in-catalog" },
			}),
		).toThrow(HostedAiBindingError);
	});

	test("omits generated nullable runtime and model cost fields", () => {
		const nullableProvider: HostedSavedAiProvider = JSON.parse(
			JSON.stringify({
				...apiKeyProvider,
				label: null,
				api_mode: null,
				runtime_env_name: null,
				models: [
					{
						id: "gpt-nullable",
						compat: {},
						supports_reasoning: null,
						context_window: null,
						max_tokens: null,
						cost: { input: 1, output: 2, cache_read: null, cache_write: null },
					},
				],
			}),
		);

		const fields = buildHostedAiBindingFields({
			managedModels,
			mode: "create",
			providers: [nullableProvider],
			selection: {
				mode: "saved",
				providerId: nullableProvider.provider_id,
				model: "gpt-nullable",
			},
		});

		expect(fields.ai_provider_bootstrap?.catalog.providers[0]).toEqual({
			id: "openai-main",
			type: "openai",
			base_url: "https://api.openai.com/v1",
			auth: { type: "api_key", source: "managed", profile: "work" },
			managed_by: "user",
			models: [{ id: "gpt-nullable", cost: { input: 1, output: 2 } }],
			capabilities: { chat: true, responses: true },
		});
	});

	test("keeps malformed and unsupported auth metadata fail closed", () => {
		const malformedProvider: HostedSavedAiProvider = JSON.parse(
			JSON.stringify({ ...apiKeyProvider, auth: { type: "api_key" } }),
		);
		expect(() =>
			buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [malformedProvider],
				selection: {
					mode: "saved",
					providerId: malformedProvider.provider_id,
					model: "gpt-catalog",
				},
			}),
		).toThrow("Invalid AI provider auth source.");
	});
});
