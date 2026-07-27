import { useEffect, useRef, useState } from "react";
import type { ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import type {
	AiBindingMode,
	AiBindingOperationMode,
	AiProviderBindingDraft,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import {
	dedupeProviderIds,
	firstModelForProvider,
	MANAGED_AI_CHOICE,
	modelIdsForProvider,
	normalizeSelectedProviderIds,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

type DraftContext = {
	managedModels: readonly ManagedModelCatalogItem[];
	operationMode: AiBindingOperationMode;
	providers: readonly AiProvider[];
};

type ProviderCatalogState = {
	dataUpdatedAt: number;
	isFetching: boolean;
	isSuccess: boolean;
};

export function changeAiBindingPrimaryProvider(
	draft: AiProviderBindingDraft,
	choice: string,
	context: DraftContext,
): AiProviderBindingDraft {
	const previous = modelIdsForProvider(
		draft.primaryProviderChoice,
		context.providers,
		context.managedModels,
	);
	const next = modelIdsForProvider(choice, context.providers, context.managedModels);
	const fallback = firstModelForProvider(choice, context.providers, context.managedModels);
	const current = draft.primaryModel;
	const trimmed = current.trim();
	const primaryModel =
		choice === MANAGED_AI_CHOICE && !next.includes(trimmed)
			? fallback
			: !trimmed
				? context.operationMode === "update"
					? fallback || current
					: fallback
				: previous.includes(trimmed) && next.length > 0 && !next.includes(trimmed)
					? fallback
					: current;
	return {
		...draft,
		bindingMode: "configured",
		providerChoices:
			choice === MANAGED_AI_CHOICE
				? [MANAGED_AI_CHOICE]
				: normalizeSelectedProviderIds(
						draft.providerChoices.filter((item) => item !== MANAGED_AI_CHOICE),
						choice,
					),
		primaryProviderChoice: choice,
		primaryModel,
	};
}

export function toggleAiBindingProvider(
	draft: AiProviderBindingDraft,
	choice: string,
	context: DraftContext,
): AiProviderBindingDraft {
	const selected = draft.providerChoices.includes(choice);
	let choices =
		choice === MANAGED_AI_CHOICE
			? [MANAGED_AI_CHOICE]
			: selected
				? draft.providerChoices.filter((item) => item !== choice)
				: draft.providerChoices.length === 1 &&
						draft.providerChoices[0] === MANAGED_AI_CHOICE &&
						choice !== MANAGED_AI_CHOICE
					? [choice]
					: [...draft.providerChoices, choice];
	if (choices.length === 0) choices = [choice];
	choices = dedupeProviderIds(choices);
	const next = { ...draft, bindingMode: "configured" as const, providerChoices: choices };
	return choices.includes(draft.primaryProviderChoice)
		? next
		: changeAiBindingPrimaryProvider(next, choices[0] ?? MANAGED_AI_CHOICE, context);
}

export function selectAiBindingProvider(
	draft: AiProviderBindingDraft,
	choice: string,
	context: DraftContext,
): AiProviderBindingDraft {
	return changeAiBindingPrimaryProvider({ ...draft, providerChoices: [choice] }, choice, context);
}

export function useAiProviderBindingDraft({
	initialDraft,
	managedCatalogReady,
	managedModels,
	operationMode,
	providerCatalog,
	providers,
	syncIdentity,
}: {
	initialDraft: AiProviderBindingDraft;
	managedCatalogReady: boolean;
	managedModels: readonly ManagedModelCatalogItem[];
	operationMode: AiBindingOperationMode;
	providerCatalog?: ProviderCatalogState;
	providers: readonly AiProvider[];
	syncIdentity?: string;
}) {
	const context = { managedModels, operationMode, providers };
	const [draft, setDraft] = useState(initialDraft);
	const [syncedIdentity, setSyncedIdentity] = useState(syncIdentity);
	const createdProvider = useRef<{ id: string; dataUpdatedAt: number } | null>(null);

	if (syncIdentity !== undefined && syncIdentity !== syncedIdentity) {
		setSyncedIdentity(syncIdentity);
		setDraft(initialDraft);
	}

	useEffect(() => {
		setDraft((current) => {
			if (current.primaryModel.trim()) return current;
			if (
				operationMode === "update" &&
				(current.bindingMode !== "configured" ||
					current.primaryProviderChoice !== MANAGED_AI_CHOICE)
			) {
				return current;
			}
			const choice = operationMode === "create" ? current.primaryProviderChoice : MANAGED_AI_CHOICE;
			const fallback = firstModelForProvider(
				choice,
				operationMode === "create" ? providers : [],
				managedModels,
			);
			return fallback ? { ...current, primaryModel: fallback } : current;
		});
	}, [draft, managedModels, operationMode, providers]);

	useEffect(() => {
		if (operationMode !== "create" || !providerCatalog) return;
		setDraft((current) => {
			const providerIds = new Set(providers.map((provider) => provider.provider_id));
			const guard = createdProvider.current;
			let choices = current.providerChoices.filter(
				(choice) => choice === MANAGED_AI_CHOICE || providerIds.has(choice),
			);
			if (choices.includes(guard?.id ?? "")) createdProvider.current = null;
			if (guard && current.providerChoices.includes(guard.id)) {
				if (providerCatalog.dataUpdatedAt <= guard.dataUpdatedAt) return current;
				createdProvider.current = null;
			}
			if (!providerCatalog.isSuccess || providerCatalog.isFetching) return current;
			if (choices.length === 0) choices = [MANAGED_AI_CHOICE];
			choices = dedupeProviderIds(choices);
			const unchanged = choices.join("\0") === current.providerChoices.join("\0");
			if (unchanged && choices.includes(current.primaryProviderChoice)) return current;
			const next = { ...current, providerChoices: choices };
			return choices.includes(current.primaryProviderChoice)
				? next
				: changeAiBindingPrimaryProvider(next, choices[0] ?? MANAGED_AI_CHOICE, context);
		});
	}, [
		draft,
		managedModels,
		operationMode,
		providerCatalog?.dataUpdatedAt,
		providerCatalog?.isFetching,
		providerCatalog?.isSuccess,
		providers,
	]);

	const selectedProviderChoices = normalizeSelectedProviderIds(
		draft.providerChoices,
		draft.primaryProviderChoice,
	);
	return {
		draft,
		selectedProviderChoices,
		managedPrimaryModelReady:
			draft.bindingMode !== "configured" ||
			draft.primaryProviderChoice !== MANAGED_AI_CHOICE ||
			(managedCatalogReady &&
				modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels).includes(draft.primaryModel)),
		setBindingMode: (bindingMode: AiBindingMode) =>
			setDraft((current) => ({ ...current, bindingMode })),
		setPrimaryModel: (primaryModel: string) =>
			setDraft((current) => ({ ...current, primaryModel })),
		setPrimaryProvider: (choice: string) =>
			setDraft((current) => changeAiBindingPrimaryProvider(current, choice, context)),
		selectProvider: (choice: string) =>
			setDraft((current) => selectAiBindingProvider(current, choice, context)),
		toggleProvider: (choice: string) =>
			setDraft((current) => toggleAiBindingProvider(current, choice, context)),
		selectCreatedProvider: (id: string, dataUpdatedAt: number) => {
			createdProvider.current = { id, dataUpdatedAt };
			setDraft((current) =>
				changeAiBindingPrimaryProvider({ ...current, providerChoices: [id] }, id, context),
			);
		},
	};
}
