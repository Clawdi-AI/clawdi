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
	providerAvailabilityIssue,
	providerChoiceFromRef,
	providerDisplayLabel,
	providerPresentation,
	providerRuntimeIncompatibility,
	usableProviders,
} from "@/hosted/v2/ai-providers/model-binding";
import {
	presetCatalogToProviderModels,
	providerPresetById,
} from "@/hosted/v2/ai-providers/provider-presets";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

const managedMetadata = {
	provider_id: "openai-codex",
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
};

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
	});

	test("does not invent a managed model before the catalog loads", () => {
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe("");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [])).toEqual([]);
	});

	test("preserves backend catalog order while selecting its declared default", () => {
		const managedModels = [
			{
				...managedMetadata,
				id: "gpt-5.6-sol",
				display_name: "GPT-5.6 Sol",
				is_default: false,
				is_featured: true,
			},
			{
				...managedMetadata,
				id: "gpt-5.6-luna",
				display_name: "GPT-5.6 Luna",
				is_default: true,
				is_featured: true,
			},
			{
				...managedMetadata,
				id: "gpt-5.6-terra",
				display_name: "GPT-5.6 Terra",
				is_default: false,
				is_featured: false,
			},
		];

		expect(
			modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels).map((model) => model.id),
		).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [], managedModels)).toBe("gpt-5.6-luna");
		expect(modelOptionsForProvider(MANAGED_AI_CHOICE, [], managedModels)).toEqual(managedModels);
		expect(modelPickerItems(MANAGED_AI_CHOICE, [], managedModels)).toEqual([
			{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
			{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
			{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
		]);
		expect(modelDisplayName("gpt-5.6-sol", managedModels)).toBe("GPT-5.6 Sol");
	});

	test("splits featured and overflow models without changing backend order", () => {
		const managedModels = [
			{
				...managedMetadata,
				description: "Higher cost for complex work.",
				id: "gpt-5.6-sol",
				display_name: "GPT-5.6 Sol",
				is_default: false,
				is_featured: true,
			},
			{
				...managedMetadata,
				description: "Variable cost for long, detailed work.",
				id: "z-ai/glm-5.3",
				display_name: "GLM-5.3",
				provider_id: "redpill",
				is_default: false,
				is_featured: true,
			},
			{
				...managedMetadata,
				id: "deepseek-v4-flash-0731",
				display_name: "DeepSeek V4 Flash 0731",
				provider_id: "redpill",
				is_default: false,
				is_featured: true,
			},
			{
				...managedMetadata,
				description: "Low cost for routine work.",
				id: "gpt-5.6-luna",
				display_name: "GPT-5.6 Luna",
				is_default: true,
				is_featured: false,
			},
			{
				...managedMetadata,
				description: "Balanced cost for everyday work.",
				id: "gpt-5.6-terra",
				display_name: "GPT-5.6 Terra",
				is_default: false,
				is_featured: false,
			},
		];

		expect(managedModelPickerItems(managedModels)).toEqual({
			featured: [
				{
					value: "gpt-5.6-sol",
					label: "GPT-5.6 Sol",
					iconId: "openai-codex",
					description: "Higher cost for complex work.",
				},
				{
					value: "z-ai/glm-5.3",
					label: "GLM-5.3",
					iconId: "zai",
					description: "Variable cost for long, detailed work.",
				},
				{
					value: "deepseek-v4-flash-0731",
					label: "DeepSeek V4 Flash 0731",
					iconId: "deepseek",
				},
			],
			overflow: [
				{
					value: "gpt-5.6-luna",
					label: "GPT-5.6 Luna",
					iconId: "openai-codex",
					description: "Low cost for routine work.",
				},
				{
					value: "gpt-5.6-terra",
					label: "GPT-5.6 Terra",
					iconId: "openai-codex",
					description: "Balanced cost for everyday work.",
				},
			],
		});
	});

	test("keeps authoritative managed display names unchanged", () => {
		const items = managedModelPickerItems([
			{
				...managedMetadata,
				id: "provider-model-a",
				display_name: "Provider Model A (Canonical)",
				is_default: true,
				is_featured: true,
			},
			{
				...managedMetadata,
				id: "provider-model-b",
				display_name: "Provider Model B — Full Name",
				is_default: false,
				is_featured: false,
			},
		]);

		expect(items.featured).toEqual([
			{
				value: "provider-model-a",
				label: "Provider Model A (Canonical)",
				iconId: "openai-codex",
			},
		]);
		expect(items.overflow).toEqual([
			{
				value: "provider-model-b",
				label: "Provider Model B — Full Name",
				iconId: "openai-codex",
			},
		]);
	});

	test("uses catalog metadata before the shared formatter and raw id fallback", () => {
		expect(
			modelDisplayName("model", [
				{
					...managedMetadata,
					id: "model",
					display_name: "Display",
					is_default: false,
					is_featured: false,
				},
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

	test("preserves preset brand identity for saved compatible providers", () => {
		const deepSeek = {
			...savedOpenAiProvider,
			provider_id: "deepseek-2",
			type: "custom_openai_compatible",
			label: "Research DeepSeek",
			base_url: "https://api.deepseek.com/v1",
			models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
			api_mode: "openai_chat",
			runtime_env_name: "DEEPSEEK_API_KEY",
		} satisfies AiProvider;

		expect(providerPresentation(deepSeek)).toMatchObject({
			label: "Research DeepSeek",
			brandLabel: "DeepSeek",
			iconId: "deepseek",
			summary: "DeepSeek · DeepSeek V4 Flash",
		});

		const proxy = {
			...deepSeek,
			provider_id: "deepseek-team",
			label: "DeepSeek proxy",
			base_url: "https://proxy.example.com/v1",
		} satisfies AiProvider;
		expect(providerPresentation(proxy)).toMatchObject({
			label: "DeepSeek proxy",
			brandLabel: "Custom (OpenAI-compatible)",
			iconId: "custom_openai_compatible",
			summary: "Custom (OpenAI-compatible) · DeepSeek V4 Flash",
		});
	});

	test("uses persisted preset catalog order without a component model default", () => {
		const preset = providerPresetById("deepseek");
		if (!preset) throw new Error("Expected the DeepSeek preset fixture.");
		const provider = {
			...savedOpenAiProvider,
			provider_id: preset.id,
			type: "custom_openai_compatible",
			base_url: preset.base_url,
			models: presetCatalogToProviderModels(preset),
		} satisfies AiProvider;
		const persistedDefault = preset.catalog[0].id;

		expect(provider.models?.[0]?.id).toBe(persistedDefault);
		expect(firstModelForProvider(provider.provider_id, [provider])).toBe(persistedDefault);
		expect(modelPickerItems(provider.provider_id, [provider], [])).toEqual(
			provider.models?.map((model) => ({
				value: model.id,
				label: model.label ?? model.id,
			})),
		);
	});

	test("uses a custom provider catalog when present and no fallback when absent", () => {
		const withCatalog = {
			...savedOpenAiProvider,
			provider_id: "custom-with-catalog",
			type: "custom_openai_compatible",
			models: [{ id: "owner-default" }, { id: "owner-alternate" }],
		} satisfies AiProvider;
		const withoutCatalog = {
			...withCatalog,
			provider_id: "custom-without-catalog",
			models: null,
		} satisfies AiProvider;

		expect(firstModelForProvider(withCatalog.provider_id, [withCatalog])).toBe("owner-default");
		expect(modelPickerItems(withCatalog.provider_id, [withCatalog], [])).toHaveLength(2);
		expect(firstModelForProvider(withoutCatalog.provider_id, [withoutCatalog])).toBe("");
		expect(modelPickerItems(withoutCatalog.provider_id, [withoutCatalog], [])).toEqual([]);
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
	});

	test("uses structured deployability instead of the legacy credential-only flag", () => {
		const readiness = {
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
		expect(
			providerAvailabilityIssue(localProvider, {
				runtime: "openclaw",
				environmentId: null,
			})?.message,
		).toBe("This credential source is local-only and cannot be delivered to a Hosted agent.");
	});

	test("preserves shared guidance when readiness metadata is missing", () => {
		const provider = {
			...savedOpenAiProvider,
			readiness: undefined,
		} satisfies AiProvider;

		expect(
			providerAvailabilityIssue(provider, {
				runtime: "openclaw",
				environmentId: null,
			})?.message,
		).toBe("Provider readiness metadata is unavailable. Refresh providers before selecting it.");
	});

	test("disables incompatible Gemini providers for Hermes with actionable guidance", () => {
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
		const issue = providerAvailabilityIssue(geminiProvider, {
			runtime: "hermes",
			environmentId: null,
		});
		expect(issue?.message).toContain("this Gemini connection");
		expect(issue?.message).not.toContain("GenerateContent");
		expect(usableProviders([geminiProvider], { runtime: "hermes", environmentId: null })).toEqual(
			[],
		);
	});

	test("preserves shared runtime compatibility guidance for non-Gemini providers", () => {
		const provider = {
			...savedOpenAiProvider,
			readiness: {
				credential_material: "available",
				runtime_compatibility: { openclaw: true, hermes: false, codex: false },
				deployable: true,
				endpoint_reachability: "not_tested",
				inference_verification: "not_tested",
			},
		} satisfies AiProvider;

		expect(providerRuntimeIncompatibility(provider, "openclaw")).toBeNull();
		expect(providerRuntimeIncompatibility(provider, "hermes")).toContain("Hermes cannot use");
		expect(
			providerAvailabilityIssue(provider, { runtime: "hermes", environmentId: null })?.message,
		).toBe("Hermes cannot use this provider's authentication or API protocol.");
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
