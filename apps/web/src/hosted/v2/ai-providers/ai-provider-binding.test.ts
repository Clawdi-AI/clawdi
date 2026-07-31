import { describe, expect, test } from "bun:test";
import {
	AiBindingBuildError,
	buildAiBindingFields,
	isUnresolvedProviderChoice,
	unresolvedProviderChoice,
	updateProviderChoiceFromRef,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import { MANAGED_AI_CHOICE, MANAGED_PROVIDER_ID } from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import {
	changeAiBindingPrimaryProvider,
	selectAiBindingProvider,
	toggleAiBindingProvider,
} from "@/hosted/v2/ai-providers/use-ai-provider-binding-draft";

const managedModels = [
	{ id: "gpt-managed", display_name: "Managed", is_default: true, is_featured: false },
];

const apiKeyProvider: AiProvider = {
	id: "row-api-key",
	provider_id: "openai-main",
	scope: "user",
	type: "openai",
	label: "OpenAI",
	base_url: "https://api.openai.com/v1",
	models: [{ id: "gpt-custom" }],
	api_mode: "openai_responses",
	auth: { type: "api_key", source: "managed" },
	usable: true,
	managed_by: "user",
	runtime_env_name: "OPENAI_API_KEY",
	capabilities: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const oauthProvider: AiProvider = {
	...apiKeyProvider,
	id: "row-oauth",
	provider_id: "codex-main",
	label: "Codex",
	auth: { type: "agent_profile", tool: "codex", profile: "default" },
};

describe("AI provider binding fields", () => {
	test("create omits update-only clear fields for an unmanaged binding", () => {
		expect(
			buildAiBindingFields(
				{
					bindingMode: "unmanaged",
					providerChoices: [MANAGED_AI_CHOICE],
					primaryProviderChoice: MANAGED_AI_CHOICE,
					primaryModel: "",
				},
				{ managedModels, mode: "create", providers: [] },
			),
		).toEqual({ ai_provider_auth_kind: "unmanaged" });
	});

	test("update explicitly clears every stale field for an unmanaged binding", () => {
		expect(
			buildAiBindingFields(
				{
					bindingMode: "unmanaged",
					providerChoices: [MANAGED_AI_CHOICE],
					primaryProviderChoice: MANAGED_AI_CHOICE,
					primaryModel: "",
				},
				{ managedModels, mode: "update", providers: [] },
			),
		).toEqual({
			ai_provider_auth_kind: "unmanaged",
			ai_provider_id: null,
			provider_ids: [],
			primary_model: null,
			ai_provider_bootstrap: null,
		});
	});

	test("create omits an empty bootstrap while update clears it", () => {
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [MANAGED_AI_CHOICE],
			primaryProviderChoice: MANAGED_AI_CHOICE,
			primaryModel: "gpt-managed",
		};

		const createFields = buildAiBindingFields(draft, {
			managedModels,
			mode: "create",
			providers: [],
		});
		const updateFields = buildAiBindingFields(draft, {
			managedModels,
			mode: "update",
			providers: [],
		});

		expect(createFields).toEqual({
			ai_provider_auth_kind: "managed",
			ai_provider_id: null,
			provider_ids: [MANAGED_PROVIDER_ID],
			primary_model: { provider_id: MANAGED_PROVIDER_ID, model: "gpt-managed" },
		});
		expect(updateFields).toEqual({ ...createFields, ai_provider_bootstrap: null });
	});

	test("uses one auth mapping and selection order for create and update bootstraps", () => {
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [oauthProvider.provider_id, apiKeyProvider.provider_id],
			primaryProviderChoice: oauthProvider.provider_id,
			primaryModel: "gpt-custom",
		};

		for (const mode of ["create", "update"] as const) {
			const fields = buildAiBindingFields(draft, {
				managedModels,
				mode,
				providers: [apiKeyProvider, oauthProvider],
			});

			expect(fields.provider_ids).toEqual([oauthProvider.provider_id, apiKeyProvider.provider_id]);
			expect(fields.ai_provider_bootstrap?.selected_provider_id).toBe(oauthProvider.provider_id);
			expect(fields.ai_provider_bootstrap?.auth_kind).toBe("codex_oauth");
			expect(
				fields.ai_provider_bootstrap?.catalog.providers.map((provider) => provider.id),
			).toEqual([oauthProvider.provider_id, apiKeyProvider.provider_id]);
		}
	});

	test("keeps managed primary and saved secondary fields identical across create and update", () => {
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [MANAGED_AI_CHOICE, apiKeyProvider.provider_id],
			primaryProviderChoice: MANAGED_AI_CHOICE,
			primaryModel: "gpt-managed",
		};

		for (const mode of ["create", "update"] as const) {
			const fields = buildAiBindingFields(draft, {
				managedModels,
				mode,
				providers: [apiKeyProvider],
			});
			expect(fields.provider_ids).toEqual([MANAGED_PROVIDER_ID, apiKeyProvider.provider_id]);
			expect(fields.primary_model).toEqual({
				provider_id: MANAGED_PROVIDER_ID,
				model: "gpt-managed",
			});
			expect(fields.ai_provider_auth_kind).toBe("managed");
			expect(fields.ai_provider_id).toBeNull();
			expect(fields.ai_provider_bootstrap?.selected_provider_id).toBe(apiKeyProvider.provider_id);
			expect(
				fields.ai_provider_bootstrap?.catalog.providers.map((provider) => provider.id),
			).toEqual([apiKeyProvider.provider_id]);
		}
	});

	test("keeps saved primary with managed and another saved provider in the ordered pool", () => {
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [oauthProvider.provider_id, MANAGED_AI_CHOICE, apiKeyProvider.provider_id],
			primaryProviderChoice: oauthProvider.provider_id,
			primaryModel: "gpt-custom",
		};

		for (const mode of ["create", "update"] as const) {
			const fields = buildAiBindingFields(draft, {
				managedModels,
				mode,
				providers: [apiKeyProvider, oauthProvider],
			});
			expect(fields.provider_ids).toEqual([
				oauthProvider.provider_id,
				MANAGED_PROVIDER_ID,
				apiKeyProvider.provider_id,
			]);
			expect(fields.primary_model).toEqual({
				provider_id: oauthProvider.provider_id,
				model: "gpt-custom",
			});
			expect(
				fields.ai_provider_bootstrap?.catalog.providers.map((provider) => provider.id),
			).toEqual([oauthProvider.provider_id, apiKeyProvider.provider_id]);
		}
	});

	test("rejects an unusable provider even if stale UI state selects it", () => {
		const unfinishedProvider = { ...oauthProvider, usable: false };
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [unfinishedProvider.provider_id],
			primaryProviderChoice: unfinishedProvider.provider_id,
			primaryModel: "gpt-custom",
		};

		expect(() =>
			buildAiBindingFields(draft, {
				managedModels,
				mode: "create",
				providers: [unfinishedProvider],
			}),
		).toThrow("has no usable credential");
	});
});

describe("AI provider binding draft transitions", () => {
	test("selects exactly one provider for the deploy flow", () => {
		const selected = selectAiBindingProvider(
			{
				bindingMode: "configured",
				providerChoices: [MANAGED_AI_CHOICE, oauthProvider.provider_id],
				primaryProviderChoice: MANAGED_AI_CHOICE,
				primaryModel: "gpt-managed",
			},
			apiKeyProvider.provider_id,
			{
				managedModels,
				operationMode: "create",
				providers: [apiKeyProvider, oauthProvider],
			},
		);

		expect(selected.providerChoices).toEqual([apiKeyProvider.provider_id]);
		expect(selected.primaryProviderChoice).toBe(apiKeyProvider.provider_id);
		expect(selected.primaryModel).toBe("gpt-custom");
		expect(
			buildAiBindingFields(selected, {
				managedModels,
				mode: "create",
				providers: [apiKeyProvider, oauthProvider],
			}).provider_ids,
		).toEqual([apiKeyProvider.provider_id]);
	});

	test("replaces a BYO provider with a managed-only update request", () => {
		const managed = toggleAiBindingProvider(
			{
				bindingMode: "configured",
				providerChoices: [apiKeyProvider.provider_id],
				primaryProviderChoice: apiKeyProvider.provider_id,
				primaryModel: "gpt-custom",
			},
			MANAGED_AI_CHOICE,
			{ managedModels, operationMode: "update", providers: [apiKeyProvider] },
		);

		expect(managed.providerChoices).toEqual([MANAGED_AI_CHOICE]);
		expect(buildAiBindingFields(managed, { managedModels, mode: "update", providers: [] })).toEqual(
			{
				ai_provider_auth_kind: "managed",
				ai_provider_id: null,
				provider_ids: [MANAGED_PROVIDER_ID],
				primary_model: { provider_id: MANAGED_PROVIDER_ID, model: "gpt-managed" },
				ai_provider_bootstrap: null,
			},
		);
	});

	test("preserves the create and update model-fallback difference", () => {
		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [MANAGED_AI_CHOICE],
			primaryProviderChoice: MANAGED_AI_CHOICE,
			primaryModel: "   ",
		};

		expect(
			changeAiBindingPrimaryProvider(draft, "missing-models", {
				managedModels,
				operationMode: "create",
				providers: [],
			}).primaryModel,
		).toBe("");
		expect(
			changeAiBindingPrimaryProvider(draft, "missing-models", {
				managedModels,
				operationMode: "update",
				providers: [],
			}).primaryModel,
		).toBe("   ");
	});

	test("keeps unresolved providers visible until the user replaces them", () => {
		const unresolved = updateProviderChoiceFromRef("deleted-provider", []);
		expect(unresolved).toBe(unresolvedProviderChoice("deleted-provider"));
		expect(unresolved && isUnresolvedProviderChoice(unresolved)).toBe(true);
		if (!unresolved) throw new Error("Expected an unresolved provider choice.");

		const draft = {
			bindingMode: "configured" as const,
			providerChoices: [unresolved],
			primaryProviderChoice: unresolved,
			primaryModel: "legacy-model",
		};
		const updateDraft = toggleAiBindingProvider(draft, MANAGED_AI_CHOICE, {
			managedModels,
			operationMode: "update",
			providers: [],
		});
		expect(updateDraft.providerChoices).toEqual([MANAGED_AI_CHOICE]);
		expect(updateDraft.primaryProviderChoice).toBe(MANAGED_AI_CHOICE);
		expect(updateDraft.primaryModel).toBe("gpt-managed");
		expect(() =>
			buildAiBindingFields(draft, { managedModels, mode: "update", providers: [] }),
		).toThrow(AiBindingBuildError);
	});
});
