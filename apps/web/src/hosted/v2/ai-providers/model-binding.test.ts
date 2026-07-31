import { describe, expect, test } from "bun:test";
import {
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_LABEL,
	modelBindingDisplayName,
	modelDisplayName,
	modelOptionsForProvider,
	primaryProviderPickerItems,
	providerChoiceFromRef,
	providerDisplayLabel,
	usableProviders,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

describe("model binding", () => {
	test("uses the canonical Clawdi AI product label", () => {
		expect(MANAGED_PROVIDER_LABEL).toBe("Clawdi AI");
		expect(primaryProviderPickerItems([MANAGED_AI_CHOICE], [])[0]?.label).toBe("Clawdi AI");
	});

	test("does not invent a managed model before the catalog loads", () => {
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe("");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [])).toEqual([]);
	});

	test("puts the catalog default first and exposes real managed model names", () => {
		const managedModels = [
			{ id: "gpt-5.6-sol", display_name: "Sol", is_default: false },
			{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true },
			{ id: "gpt-5.6-terra", display_name: "Terra", is_default: false },
		];

		expect(
			modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels).map((model) => model.id),
		).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [], managedModels)).toBe("gpt-5.6-luna");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels)).toEqual([
			managedModels[1],
			managedModels[0],
			managedModels[2],
		]);
		expect(modelDisplayName("gpt-5.6-sol", managedModels)).toBe("Sol");
	});

	test("uses catalog metadata before the shared formatter and raw id fallback", () => {
		expect(
			modelDisplayName("model", [{ id: "model", display_name: "Display", is_default: false }]),
		).toBe("Display");
		expect(modelDisplayName("model", [{ id: "model", label: "Label", alias: "Alias" }])).toBe(
			"Label",
		);
		expect(modelDisplayName("model", [{ id: "model", alias: "Alias" }])).toBe("Alias");
		expect(modelDisplayName("gpt-5.4", [])).toBe("GPT 5.4");
		expect(modelDisplayName("unknown/model", [])).toBe("unknown/model");
	});

	test("uses the first catalog model for a selected provider", () => {
		const providers = [
			{
				id: "row-openai",
				provider_id: "openai-main",
				scope: "account_global",
				type: "openai",
				base_url: "https://api.openai.com/v1",
				models: [{ id: "gpt-5.5", label: "GPT Latest" }, { id: "gpt-5.4" }],
				api_mode: "openai_responses",
				auth: { type: "api_key", source: "managed" },
				usable: true,
				managed_by: "user",
				runtime_env_name: "OPENAI_API_KEY",
				capabilities: null,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
				label: "OpenAI",
			} satisfies AiProvider,
		];

		expect(firstModelForProvider("openai-main", providers)).toBe("gpt-5.5");
		expect(modelOptionsForProvider("openai-main", providers)).toEqual(providers[0].models);
		expect(modelDisplayName("gpt-5.5", providers[0].models ?? [])).toBe("GPT Latest");
		expect(providerDisplayLabel(providers[0])).toBe("OpenAI");
		expect(providerDisplayLabel("openai-main", providers)).toBe("OpenAI");
		expect(providerDisplayLabel({ ...providers[0], label: null })).toBe("OpenAI");
	});

	test("does not offer an unfinished provider as a deploy selection", () => {
		const unfinishedProvider = {
			id: "row-codex",
			provider_id: "openai-codex",
			scope: "account_global",
			type: "openai",
			base_url: "https://api.openai.com/v1",
			models: [{ id: "gpt-5.5" }],
			api_mode: "openai_responses",
			auth: { type: "agent_profile", tool: "codex", profile: "default" },
			usable: false,
			managed_by: "user",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			label: "Codex",
		} satisfies AiProvider;
		const selectable = usableProviders([unfinishedProvider]);

		expect(selectable).toEqual([]);
		expect(primaryProviderPickerItems([unfinishedProvider.provider_id], selectable)).toEqual([]);
	});

	test("maps deployment-scoped managed provider ids to the friendly managed choice", () => {
		const providerId = "clawdi-v2-deployment-10";
		expect(isManagedProviderId(providerId)).toBe(true);
		expect(providerChoiceFromRef(providerId, [])).toBe(MANAGED_AI_CHOICE);
		expect(providerDisplayLabel(providerId)).toBe(MANAGED_PROVIDER_LABEL);
	});

	test("labels empty bindings from their actual auth mode", () => {
		expect(modelBindingDisplayName(null, "managed", [])).toBe("Clawdi AI default");
		expect(modelBindingDisplayName(null, "unmanaged", [])).toBe("Configured in agent");
		expect(modelBindingDisplayName(null, "api_key", [])).toBe("Not set");
	});
});
