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

const managedModels = [{ id: "gpt-managed", display_name: "Managed", is_default: true }];

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
			providerChoices: [MANAGED_AI_CHOICE, oauthProvider.provider_id, apiKeyProvider.provider_id],
			primaryProviderChoice: MANAGED_AI_CHOICE,
			primaryModel: "gpt-managed",
		};

		for (const mode of ["create", "update"] as const) {
			const fields = buildAiBindingFields(draft, {
				managedModels,
				mode,
				providers: [apiKeyProvider, oauthProvider],
			});

			expect(fields.provider_ids).toEqual([
				MANAGED_PROVIDER_ID,
				oauthProvider.provider_id,
				apiKeyProvider.provider_id,
			]);
			expect(fields.ai_provider_bootstrap?.selected_provider_id).toBe(oauthProvider.provider_id);
			expect(fields.ai_provider_bootstrap?.auth_kind).toBe("codex_oauth");
			expect(
				fields.ai_provider_bootstrap?.catalog.providers.map((provider) => provider.id),
			).toEqual([oauthProvider.provider_id, apiKeyProvider.provider_id]);
		}
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

	test("keeps unresolved providers visible only for update and replaces them with managed", () => {
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
		const createDraft = toggleAiBindingProvider(draft, MANAGED_AI_CHOICE, {
			managedModels,
			operationMode: "create",
			providers: [],
		});

		expect(updateDraft.providerChoices).toEqual([MANAGED_AI_CHOICE]);
		expect(updateDraft.primaryProviderChoice).toBe(MANAGED_AI_CHOICE);
		expect(updateDraft.primaryModel).toBe("gpt-managed");
		expect(createDraft.providerChoices).toEqual([unresolved, MANAGED_AI_CHOICE]);
		expect(createDraft.primaryProviderChoice).toBe(unresolved);
		expect(() =>
			buildAiBindingFields(draft, { managedModels, mode: "update", providers: [] }),
		).toThrow(AiBindingBuildError);
	});
});
