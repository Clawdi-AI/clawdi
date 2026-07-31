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
	buildHostedAiProviderPoolBootstrap,
	HostedAiBindingError,
	type HostedSavedAiProvider,
	toHostedRuntimeAiProvider,
} from "./hosted-ai-binding";

const managedModels = [
	{
		id: "gpt-managed",
		display_name: "Managed",
		is_default: true,
		is_featured: false,
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
	models: [{ id: "gpt-catalog" }],
	auth: { type: "api_key", source: "managed", profile: "work" },
	usable: true,
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

const secondaryProvider = {
	...apiKeyProvider,
	id: "row-secondary",
	provider_id: "openai-secondary",
	label: "OpenAI Secondary",
	models: [{ id: "gpt-secondary" }],
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
					providerIds: [apiKeyProvider.provider_id],
					primaryProviderId: apiKeyProvider.provider_id,
					model,
				},
			});
			expect(fields).toMatchObject({
				ai_provider_auth_kind: "api_key",
				ai_provider_id: "openai-main",
				provider_ids: ["openai-main"],
				primary_model: { provider_id: "openai-main", model },
				ai_provider_bootstrap: {
					selected_provider_id: "openai-main",
					auth_kind: "api_key",
				},
			});
			expect(fields.ai_provider_bootstrap?.catalog.providers[0]?.auth).toEqual({
				type: "api_key",
				source: "managed",
				profile: "work",
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
				providerIds: [codexProvider.provider_id],
				primaryProviderId: codexProvider.provider_id,
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

	test("preserves a managed primary with an ordered saved secondary", () => {
		for (const mode of ["create", "update"] as const) {
			expect(
				buildHostedAiBindingFields({
					managedModels,
					mode,
					providers: [apiKeyProvider],
					selection: {
						mode: "managed",
						model: "gpt-managed",
						providerIds: [CLAWDI_MANAGED_PROVIDER_ID, apiKeyProvider.provider_id],
					},
				}),
			).toEqual({
				ai_provider_auth_kind: "managed",
				ai_provider_id: null,
				provider_ids: [CLAWDI_MANAGED_PROVIDER_ID, "openai-main"],
				primary_model: {
					provider_id: CLAWDI_MANAGED_PROVIDER_ID,
					model: "gpt-managed",
				},
				ai_provider_bootstrap: {
					schema_version: 1,
					selected_provider_id: "openai-main",
					auth_kind: "api_key",
					catalog: {
						schema_version: 1,
						providers: [
							{
								id: "openai-main",
								type: "openai",
								label: "OpenAI",
								base_url: "https://api.openai.com/v1",
								auth: { type: "api_key", source: "managed", profile: "work" },
								managed_by: "user",
								models: [{ id: "gpt-catalog" }],
								api_mode: "openai_responses",
								runtime_env_name: "OPENAI_API_KEY",
								capabilities: { chat: true, responses: true },
							},
						],
						defaults: { chat_provider_id: "openai-main" },
					},
				},
			});
		}
	});

	test("rejects noncanonical first-party managed secondaries in a managed pool", () => {
		for (const provider of noncanonicalManagedProviders) {
			expect(() =>
				buildHostedAiBindingFields({
					managedModels,
					mode: "create",
					providers: [apiKeyProvider, provider],
					selection: {
						mode: "managed",
						model: "gpt-managed",
						providerIds: [
							CLAWDI_MANAGED_PROVIDER_ID,
							apiKeyProvider.provider_id,
							provider.provider_id,
						],
					},
				}),
			).toThrow("cannot be used as a saved provider");
		}
	});

	test("preserves a canonical managed secondary without materializing it in saved bootstrap", () => {
		const canonicalManagedProvider = {
			...apiKeyProvider,
			id: "row-managed-v2",
			provider_id: CLAWDI_MANAGED_PROVIDER_ID,
			managed_by: "clawdi",
		} satisfies HostedSavedAiProvider;

		for (const includeCanonicalRow of [false, true]) {
			for (const mode of ["create", "update"] as const) {
				const fields = buildHostedAiBindingFields({
					managedModels,
					mode,
					providers: [
						apiKeyProvider,
						codexProvider,
						...(includeCanonicalRow ? [canonicalManagedProvider] : []),
						secondaryProvider,
					],
					selection: {
						mode: "saved",
						model: "gpt-codex",
						primaryProviderId: codexProvider.provider_id,
						providerIds: [
							codexProvider.provider_id,
							CLAWDI_MANAGED_PROVIDER_ID,
							secondaryProvider.provider_id,
						],
					},
				});

				expect(fields.provider_ids).toEqual([
					"codex-main",
					CLAWDI_MANAGED_PROVIDER_ID,
					"openai-secondary",
				]);
				expect(fields.primary_model).toEqual({
					provider_id: "codex-main",
					model: "gpt-codex",
				});
				expect(fields.ai_provider_id).toBe("codex-main");
				expect(fields.ai_provider_auth_kind).toBe("codex_oauth");
				expect(fields.ai_provider_bootstrap?.selected_provider_id).toBe("codex-main");
				expect(fields.ai_provider_bootstrap?.auth_kind).toBe("codex_oauth");
				expect(
					fields.ai_provider_bootstrap?.catalog.providers.map((provider) => provider.id),
				).toEqual(["codex-main", "openai-secondary"]);
			}
		}
	});

	test("rejects canonical managed provider as a saved primary with or without its row", () => {
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
						providerIds: [CLAWDI_MANAGED_PROVIDER_ID],
						primaryProviderId: CLAWDI_MANAGED_PROVIDER_ID,
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

	test("rejects noncanonical first-party managed providers anywhere in a saved pool", () => {
		for (const provider of noncanonicalManagedProviders) {
			for (const asPrimary of [false, true]) {
				try {
					buildHostedAiBindingFields({
						managedModels,
						mode: "create",
						providers: [apiKeyProvider, provider],
						selection: {
							mode: "saved",
							providerIds: asPrimary
								? [provider.provider_id]
								: [apiKeyProvider.provider_id, provider.provider_id],
							primaryProviderId: asPrimary ? provider.provider_id : apiKeyProvider.provider_id,
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
					providerIds: [apiKeyProvider.provider_id],
					primaryProviderId: apiKeyProvider.provider_id,
					model: "gpt-catalog",
				},
			});
		expect(() => buildSaved([])).toThrow("is unavailable");
		expect(() => buildSaved([{ ...apiKeyProvider, usable: false }])).toThrow(
			"has no usable credential",
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

	test("validates the projected provider catalog before returning bootstrap", () => {
		expect(() =>
			buildHostedAiProviderPoolBootstrap(
				[
					{
						...apiKeyProvider,
						provider_id: "public-no-auth",
						type: "custom_openai_compatible",
						base_url: "https://example.com/v1",
						auth: { type: "none" },
					},
				],
				"public-no-auth",
				"api_key",
			),
		).toThrow("uses no auth on a public URL");
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
						supports_reasoning: null,
						context_window: null,
						max_tokens: null,
						cost: { input: 1, output: 2, cache_read: null, cache_write: null },
					},
				],
			}),
		);

		expect(toHostedRuntimeAiProvider(nullableProvider)).toEqual({
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
			buildHostedAiProviderPoolBootstrap(
				[malformedProvider],
				malformedProvider.provider_id,
				"api_key",
			),
		).toThrow("Invalid AI provider auth source.");
	});
});
