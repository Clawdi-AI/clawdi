import {
	CLAWDI_MANAGED_PROVIDER_IDS,
	CLAWDI_MANAGED_V2_PROVIDER_ID,
	isFirstPartyManagedAiProvider,
} from "@clawdi/shared";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export const MANAGED_AI_CHOICE = "__managed__";
export const MANAGED_PROVIDER_ID = CLAWDI_MANAGED_V2_PROVIDER_ID;
export const MANAGED_PRIMARY_MODEL_FALLBACK = "gpt-5";

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
	return typeof providerId === "string" && CLAWDI_MANAGED_PROVIDER_IDS.has(providerId);
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

export function modelIdsForProvider(choice: string, providers: readonly AiProvider[]): string[] {
	if (choice === MANAGED_AI_CHOICE) {
		const managed = providers.find((provider) => isFirstPartyManagedAiProvider(provider));
		return dedupeProviderIds((managed?.models ?? []).map((model) => model.id));
	}
	const provider = providers.find((item) => item.provider_id === choice);
	return dedupeProviderIds((provider?.models ?? []).map((model) => model.id));
}

export function firstModelForProvider(choice: string, providers: readonly AiProvider[]): string {
	const [first] = modelIdsForProvider(choice, providers);
	return first ?? (choice === MANAGED_AI_CHOICE ? MANAGED_PRIMARY_MODEL_FALLBACK : "");
}

export function normalizeSelectedProviderIds(
	choices: readonly string[],
	primaryChoice: string,
): string[] {
	const normalized = dedupeProviderIds(choices);
	if (normalized.includes(primaryChoice)) return normalized;
	return dedupeProviderIds([primaryChoice, ...normalized]);
}
