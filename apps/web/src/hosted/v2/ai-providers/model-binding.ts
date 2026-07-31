import {
	CLAWDI_MANAGED_PROVIDER_ID,
	isClawdiManagedProviderId,
	isFirstPartyManagedAiProvider,
} from "@clawdi/shared";
import type { AiProviderAuthKind, ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import { type HostedRuntime, runtimeDisplayName } from "@/hosted/runtimes";
import { providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { formatModelLabel } from "@/lib/format";

export const MANAGED_AI_CHOICE = "__managed__";
export const MANAGED_PROVIDER_ID = CLAWDI_MANAGED_PROVIDER_ID;
export const MANAGED_PROVIDER_LABEL = "Clawdi AI";
export const CUSTOM_MODEL_CHOICE = "__custom__";

type AiProviderModel = NonNullable<AiProvider["models"]>[number];
export type ModelCatalogItem = ManagedModelCatalogItem | AiProviderModel;

export type ModelBindingPickerItem = {
	value: string;
	label: string;
};

export type ManagedModelPickerItems = {
	featured: ModelBindingPickerItem[];
	overflow: ModelBindingPickerItem[];
};

export type PrimaryModelRef = {
	provider_id: string;
	model: string;
};

export type PrimaryModelInput = string | PrimaryModelRef | null | undefined;

export function isPrimaryModelRef(value: PrimaryModelInput): value is PrimaryModelRef {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.provider_id === "string" &&
		typeof value.model === "string"
	);
}

export function primaryModelValue(value: PrimaryModelInput): string {
	if (isPrimaryModelRef(value)) return value.model;
	return typeof value === "string" ? value : "";
}

export function primaryModelProviderId(value: PrimaryModelInput): string | null {
	if (!isPrimaryModelRef(value)) return null;
	return value.provider_id || null;
}

export function primaryModelRef(providerId: string, model: string): PrimaryModelRef | null {
	const provider_id = providerId.trim();
	const value = model.trim();
	if (!provider_id || !value) return null;
	return { provider_id, model: value };
}

export function dedupeProviderIds(providerIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of providerIds) {
		const providerId = raw.trim();
		if (!providerId || seen.has(providerId)) continue;
		seen.add(providerId);
		result.push(providerId);
	}
	return result;
}

export function isManagedProviderId(providerId: string | null | undefined): boolean {
	return typeof providerId === "string" && isClawdiManagedProviderId(providerId);
}

export function providerRuntimeIncompatibility(
	provider: AiProvider,
	runtime: HostedRuntime,
): string | null {
	const compatible = provider.readiness?.runtime_compatibility[runtime];
	if (compatible === true) return null;
	if (runtime === "hermes" && provider.api_mode === "google_generate_content") {
		return "Hermes cannot use Gemini GenerateContent yet. Choose OpenClaw, or use an OpenAI- or Anthropic-compatible provider.";
	}
	if (compatible === false) {
		return `${runtimeDisplayName(runtime)} cannot use this provider's authentication or API protocol.`;
	}
	return null;
}

export function usableProviders(
	providers: readonly AiProvider[],
	runtime?: HostedRuntime,
): AiProvider[] {
	return providers.filter(
		(provider) =>
			(provider.readiness?.deployable ?? provider.usable) &&
			provider.auth.type !== "none" &&
			(!runtime || providerRuntimeIncompatibility(provider, runtime) === null),
	);
}

export function providerDisplayLabel(
	provider: AiProvider | string,
	providers: readonly AiProvider[] = [],
): string {
	if (typeof provider === "string") {
		if (isManagedProviderId(provider)) return MANAGED_PROVIDER_LABEL;
		const match = providers.find((item) => item.id === provider || item.provider_id === provider);
		return match ? providerDisplayLabel(match) : "Custom provider";
	}
	return isFirstPartyManagedAiProvider(provider)
		? MANAGED_PROVIDER_LABEL
		: provider.label?.trim() || providerTypeMeta(provider.type).label;
}

export function providerChoiceFromRef(
	providerRef: string | null | undefined,
	providers: readonly AiProvider[],
): string | null {
	if (!providerRef) return null;
	if (isManagedProviderId(providerRef)) return MANAGED_AI_CHOICE;
	const match = providers.find(
		(provider) => provider.id === providerRef || provider.provider_id === providerRef,
	);
	return match?.provider_id ?? providerRef;
}

export function providerRefFromChoice(
	choice: string,
	providers: readonly AiProvider[],
): string | null {
	if (choice === MANAGED_AI_CHOICE) return MANAGED_PROVIDER_ID;
	const match = providers.find((provider) => provider.provider_id === choice);
	return match?.provider_id ?? null;
}

export function modelOptionsForProvider(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[] = [],
): ModelCatalogItem[] {
	let models: readonly ModelCatalogItem[];
	if (choice === MANAGED_AI_CHOICE || isManagedProviderId(choice)) {
		models = managedModels;
	} else {
		models =
			providers.find((item) => item.id === choice || item.provider_id === choice)?.models ?? [];
	}

	const seen = new Set<string>();
	return models.filter((model) => {
		const id = model.id.trim();
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

export function modelIdsForProvider(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[] = [],
): string[] {
	return modelOptionsForProvider(choice, providers, managedModels).map((model) => model.id);
}

export function modelDisplayName(modelId: string, catalog: readonly ModelCatalogItem[]): string {
	const model = catalog.find((item) => item.id === modelId);
	const displayName = model && "display_name" in model ? model.display_name : undefined;
	const label = model && "label" in model ? model.label : undefined;
	const alias = model && "alias" in model ? model.alias : undefined;
	return displayName || label || alias || formatModelLabel(modelId) || modelId;
}

export function providerCatalogDescription(provider: AiProvider): string {
	const models = provider.models ?? [];
	if (models.length === 0) return provider.base_url.replace(/^https?:\/\//, "");
	if (models.length === 1 && models[0]) return modelDisplayName(models[0].id, models);
	return `${models.length} catalog models`;
}

export function modelBindingDisplayName(
	primaryModel: PrimaryModelInput,
	authKind: AiProviderAuthKind | "secret_reference" | undefined,
	catalog: readonly ModelCatalogItem[],
): string {
	const modelId = primaryModelValue(primaryModel);
	if (modelId) return modelDisplayName(modelId, catalog);
	if (authKind === "managed") return "Clawdi AI default";
	if (authKind === "unmanaged") return "Configured in agent";
	return "Not set";
}

export function primaryProviderPickerItems(
	selectedProviderChoices: readonly string[],
	providers: readonly AiProvider[],
	additionalItems: readonly ModelBindingPickerItem[] = [],
): ModelBindingPickerItem[] {
	return [
		...(selectedProviderChoices.includes(MANAGED_AI_CHOICE)
			? [{ value: MANAGED_AI_CHOICE, label: MANAGED_PROVIDER_LABEL }]
			: []),
		...additionalItems,
		...providers
			.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
			.map((provider) => ({
				value: provider.provider_id,
				label: providerDisplayLabel(provider),
			})),
	];
}

export function modelPickerItems(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[],
): ModelBindingPickerItem[] {
	const models = modelOptionsForProvider(choice, providers, managedModels);
	return [
		...models.map((model) => ({
			value: model.id,
			label: modelDisplayName(model.id, [model]),
		})),
		...(choice === MANAGED_AI_CHOICE
			? []
			: [{ value: CUSTOM_MODEL_CHOICE, label: "Custom model" }]),
	];
}

export function managedModelPickerItems(
	managedModels: readonly ManagedModelCatalogItem[],
): ManagedModelPickerItems {
	const sections: ManagedModelPickerItems = { featured: [], overflow: [] };
	const seen = new Set<string>();
	for (const model of managedModels) {
		const modelId = model.id.trim();
		if (!modelId || seen.has(modelId)) continue;
		seen.add(modelId);
		const item = {
			value: modelId,
			label: modelDisplayName(modelId, [model]),
		};
		sections[model.is_featured ? "featured" : "overflow"].push(item);
	}
	return sections;
}

export function firstModelForProvider(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[] = [],
): string {
	const models = modelOptionsForProvider(choice, providers, managedModels);
	if (choice === MANAGED_AI_CHOICE || isManagedProviderId(choice)) {
		return (
			models.find((model) => "is_default" in model && model.is_default)?.id ?? models[0]?.id ?? ""
		);
	}
	return models[0]?.id ?? "";
}

export function normalizeSelectedProviderIds(
	choices: readonly string[],
	primaryChoice: string,
): string[] {
	const normalized = dedupeProviderIds(choices);
	if (normalized.includes(primaryChoice)) return normalized;
	return dedupeProviderIds([primaryChoice, ...normalized]);
}
