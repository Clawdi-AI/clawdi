import { CLAWDI_MANAGED_V2_PROVIDER_ID, isClawdiManagedProviderId } from "@clawdi/shared";
import type { ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export const MANAGED_AI_CHOICE = "__managed__";
export const MANAGED_PROVIDER_ID = CLAWDI_MANAGED_V2_PROVIDER_ID;
export const CUSTOM_MODEL_CHOICE = "__custom__";

export type ModelBindingPickerItem = {
	value: string;
	label: string;
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

export function modelIdsForProvider(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[] = [],
): string[] {
	if (choice === MANAGED_AI_CHOICE) {
		const defaultModel = managedModels.find((model) => model.is_default)?.id ?? "";
		return dedupeProviderIds([defaultModel, ...managedModels.map((model) => model.id)]);
	}
	const provider = providers.find((item) => item.provider_id === choice);
	return dedupeProviderIds((provider?.models ?? []).map((model) => model.id));
}

export function managedModelDisplayName(
	modelId: string,
	managedModels: readonly ManagedModelCatalogItem[],
): string | null {
	return managedModels.find((model) => model.id === modelId)?.display_name ?? null;
}

export function managedModelPickerItems(
	managedModels: readonly ManagedModelCatalogItem[],
): ModelBindingPickerItem[] {
	return modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels).map((modelId) => ({
		value: modelId,
		label: managedModelDisplayName(modelId, managedModels) ?? modelId,
	}));
}

export function primaryProviderPickerItems(
	selectedProviderChoices: readonly string[],
	providers: readonly AiProvider[],
	additionalItems: readonly ModelBindingPickerItem[] = [],
): ModelBindingPickerItem[] {
	return [
		...(selectedProviderChoices.includes(MANAGED_AI_CHOICE)
			? [{ value: MANAGED_AI_CHOICE, label: "Managed by Clawdi" }]
			: []),
		...additionalItems,
		...providers
			.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
			.map((provider) => ({
				value: provider.provider_id,
				label: provider.label ?? provider.provider_id,
			})),
	];
}

export function modelPickerItems(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[],
	formatModel: (modelId: string) => string = (modelId) => modelId,
): ModelBindingPickerItem[] {
	if (choice === MANAGED_AI_CHOICE) return managedModelPickerItems(managedModels);
	return [
		...modelIdsForProvider(choice, providers).map((modelId) => ({
			value: modelId,
			label: formatModel(modelId),
		})),
		{ value: CUSTOM_MODEL_CHOICE, label: "Custom model" },
	];
}

export function primaryModelPickerChoice(
	primaryModel: string,
	catalogModelIds: readonly string[],
): string {
	return catalogModelIds.includes(primaryModel) ? primaryModel : CUSTOM_MODEL_CHOICE;
}

export function firstModelForProvider(
	choice: string,
	providers: readonly AiProvider[],
	managedModels: readonly ManagedModelCatalogItem[] = [],
): string {
	const [first] = modelIdsForProvider(choice, providers, managedModels);
	return first ?? "";
}

export function normalizeSelectedProviderIds(
	choices: readonly string[],
	primaryChoice: string,
): string[] {
	const normalized = dedupeProviderIds(choices);
	if (normalized.includes(primaryChoice)) return normalized;
	return dedupeProviderIds([primaryChoice, ...normalized]);
}
