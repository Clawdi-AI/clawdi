import { describe, expect, test } from "bun:test";
import {
	firstModelForProvider,
	isManagedProviderId,
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_LABEL,
	managedModelPickerItems,
	modelBindingDisplayName,
	modelDisplayName,
	modelOptionsForProvider,
	modelPickerItems,
	primaryProviderPickerItems,
	providerAvailabilityIssue,
	providerChoiceFromRef,
	providerDisplayLabel,
	providerRuntimeIncompatibility,
	usableProviders,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

const savedOpenAiProvider = {
	id: "row-openai",
	provider_id: "openai-main",
	scope: "account_global",
	type: "openai",
	base_url: "https://api.openai.com/v1",
	models: [{ id: "gpt-5.5", label: "GPT Latest" }, { id: "gpt-5.4" }],
	api_mode: "openai_responses",
	auth: { type: "api_key", source: "managed" },
	usable: true,
	readiness: {
		contract_version: 1,
		credential_material: "available",
		runtime_compatibility: { openclaw: true, hermes: true, codex: true },
		deployable: true,
		endpoint_reachability: "not_tested",
		inference_verification: "not_tested",
	},
	managed_by: "user",
	runtime_env_name: "OPENAI_API_KEY",
	capabilities: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	label: "OpenAI",
} satisfies AiProvider;

describe("model binding", () => {
	test("uses the canonical Clawdi AI product label", () => {
		expect(MANAGED_PROVIDER_LABEL).toBe("Clawdi AI");
		expect(primaryProviderPickerItems([MANAGED_AI_CHOICE], [])[0]?.label).toBe("Clawdi AI");
	});

	test("does not invent a managed model before the catalog loads", () => {
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe("");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [])).toEqual([]);
	});

	test("preserves backend catalog order while selecting its declared default", () => {
		const managedModels = [
			{ id: "gpt-5.6-sol", display_name: "Sol", is_default: false, is_featured: true },
			{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true, is_featured: true },
			{ id: "gpt-5.6-terra", display_name: "Terra", is_default: false, is_featured: false },
		];

		expect(
			modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels).map((model) => model.id),
		).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [], managedModels)).toBe("gpt-5.6-luna");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels)).toEqual(managedModels);
		expect(modelPickerItems(MANAGED_AI_CHOICE, [], managedModels)).toEqual([
			{ value: "gpt-5.6-sol", label: "Sol" },
			{ value: "gpt-5.6-luna", label: "Luna" },
			{ value: "gpt-5.6-terra", label: "Terra" },
		]);
		expect(modelDisplayName("gpt-5.6-sol", managedModels)).toBe("Sol");
	});

	test("splits featured and overflow models without changing backend order", () => {
		const managedModels = [
			{ id: "gpt-5.6-sol", display_name: "Sol", is_default: false, is_featured: true },
			{ id: "k3", display_name: "Kimi K3", is_default: false, is_featured: true },
			{ id: "future-model", display_name: "Future model", is_default: false, is_featured: false },
			{ id: "gpt-5.6-luna", display_name: "Luna", is_default: true, is_featured: false },
			{ id: "gpt-5.6-terra", display_name: "Terra", is_default: false, is_featured: false },
		];

		expect(managedModelPickerItems(managedModels)).toEqual({
			featured: [
				{ value: "gpt-5.6-sol", label: "Sol" },
				{ value: "k3", label: "Kimi K3" },
			],
			overflow: [
				{ value: "future-model", label: "Future model" },
				{ value: "gpt-5.6-luna", label: "Luna" },
				{ value: "gpt-5.6-terra", label: "Terra" },
			],
		});
	});

	test("uses catalog metadata before the shared formatter and raw id fallback", () => {
		expect(
			modelDisplayName("model", [
				{ id: "model", display_name: "Display", is_default: false, is_featured: false },
			]),
		).toBe("Display");
		expect(modelDisplayName("model", [{ id: "model", label: "Label", alias: "Alias" }])).toBe(
			"Label",
		);
		expect(modelDisplayName("model", [{ id: "model", alias: "Alias" }])).toBe("Alias");
		expect(modelDisplayName("gpt-5.4", [])).toBe("GPT 5.4");
		expect(modelDisplayName("unknown/model", [])).toBe("unknown/model");
	});

	test("uses the first catalog model for a selected provider", () => {
		const providers = [savedOpenAiProvider];

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

	test("uses structured deployability instead of the legacy credential-only flag", () => {
		const readiness = {
			contract_version: 1,
			credential_material: "available",
			runtime_compatibility: { openclaw: true, hermes: true, codex: false },
			deployable: true,
			endpoint_reachability: "not_tested",
			inference_verification: "not_tested",
		} as const;
		const deployable = { ...savedOpenAiProvider, usable: false, readiness } satisfies AiProvider;
		const blocked = {
			...savedOpenAiProvider,
			provider_id: "blocked-provider",
			readiness: { ...readiness, deployable: false },
		} satisfies AiProvider;

		expect(usableProviders([deployable, blocked])).toEqual([deployable]);
	});

	test("does not offer legacy local-only providers to hosted agents", () => {
		const localProvider = {
			...savedOpenAiProvider,
			provider_id: "local-no-auth",
			base_url: "http://127.0.0.1:11434/v1",
			auth: { type: "none" },
			usable: true,
		} satisfies AiProvider;

		expect(usableProviders([localProvider])).toEqual([]);
	});

	test("disables Gemini GenerateContent for Hermes with actionable guidance", () => {
		const geminiProvider = {
			...savedOpenAiProvider,
			provider_id: "gemini-main",
			type: "gemini",
			api_mode: "google_generate_content",
			models: [{ id: "gemini-3.1-pro-preview" }],
			readiness: {
				...savedOpenAiProvider.readiness,
				runtime_compatibility: { openclaw: true, hermes: false, codex: false },
			},
		} satisfies AiProvider;

		expect(providerRuntimeIncompatibility(geminiProvider, "openclaw")).toBeNull();
		expect(providerRuntimeIncompatibility(geminiProvider, "hermes")).toContain("Choose OpenClaw");
		expect(usableProviders([geminiProvider], { runtime: "hermes", environmentId: null })).toEqual(
			[],
		);
	});

	test("uses backend runtime compatibility for non-Gemini providers", () => {
		const provider = {
			...savedOpenAiProvider,
			readiness: {
				contract_version: 1,
				credential_material: "available",
				runtime_compatibility: { openclaw: true, hermes: false, codex: false },
				deployable: true,
				endpoint_reachability: "not_tested",
				inference_verification: "not_tested",
			},
		} satisfies AiProvider;

		expect(providerRuntimeIncompatibility(provider, "openclaw")).toBeNull();
		expect(providerRuntimeIncompatibility(provider, "hermes")).toContain("Hermes cannot use");
		expect(usableProviders([provider], { runtime: "hermes", environmentId: null })).toEqual([]);
	});

	test("gates claimed connections by current Agent ownership", () => {
		const claimed = {
			...savedOpenAiProvider,
			consumer: { environment_id: "agent-a", runtime: "openclaw" },
		} satisfies AiProvider;

		expect(
			providerAvailabilityIssue(claimed, {
				runtime: "openclaw",
				environmentId: "agent-a",
			}),
		).toBeNull();
		expect(
			providerAvailabilityIssue(claimed, {
				runtime: "openclaw",
				environmentId: "agent-b",
			})?.message,
		).toBe("Used by another agent. Add another ChatGPT connection.");
		expect(
			providerAvailabilityIssue(claimed, {
				runtime: "hermes",
				environmentId: "agent-a",
			})?.message,
		).toBe("Used by this agent's openclaw runtime. Add another ChatGPT connection.");
		expect(usableProviders([claimed], { runtime: "openclaw", environmentId: null })).toEqual([]);
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
