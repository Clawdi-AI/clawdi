import { useEffect, useState } from "react";
import type { ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import type {
	AiBindingMode,
	AiBindingOperationMode,
	AiProviderBindingDraft,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import {
	firstModelForProvider,
	MANAGED_AI_CHOICE,
	modelIdsForProvider,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

type DraftContext = {
	managedModels: readonly ManagedModelCatalogItem[];
	providers: readonly AiProvider[];
};

export function selectAiBindingProvider(
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
	const defaultModel = firstModelForProvider(choice, context.providers, context.managedModels);
	const current = draft.primaryModel;
	const trimmed = current.trim();
	const primaryModel =
		choice === MANAGED_AI_CHOICE && !next.includes(trimmed)
			? defaultModel
			: !trimmed
				? defaultModel
				: previous.includes(trimmed) && !next.includes(trimmed)
					? defaultModel
					: current;
	return {
		...draft,
		bindingMode: "configured",
		primaryProviderChoice: choice,
		primaryModel,
	};
}

export function useAiProviderBindingDraft({
	initialDraft,
	managedCatalogReady,
	managedModels,
	operationMode,
	providers,
	syncIdentity,
}: {
	initialDraft: AiProviderBindingDraft;
	managedCatalogReady: boolean;
	managedModels: readonly ManagedModelCatalogItem[];
	operationMode: AiBindingOperationMode;
	providers: readonly AiProvider[];
	syncIdentity?: string;
}) {
	const context = { managedModels, providers };
	const [draft, setDraft] = useState(initialDraft);
	const [syncedIdentity, setSyncedIdentity] = useState(syncIdentity);

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
			const defaultModel = firstModelForProvider(
				choice,
				operationMode === "create" ? providers : [],
				managedModels,
			);
			return defaultModel ? { ...current, primaryModel: defaultModel } : current;
		});
	}, [draft, managedModels, operationMode, providers]);

	return {
		draft,
		managedPrimaryModelReady:
			draft.bindingMode !== "configured" ||
			draft.primaryProviderChoice !== MANAGED_AI_CHOICE ||
			(managedCatalogReady &&
				modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels).includes(draft.primaryModel)),
		setBindingMode: (bindingMode: AiBindingMode) =>
			setDraft((current) => ({ ...current, bindingMode })),
		setPrimaryModel: (primaryModel: string) =>
			setDraft((current) => ({ ...current, primaryModel })),
		selectProvider: (choice: string) =>
			setDraft((current) => selectAiBindingProvider(current, choice, context)),
		selectCreatedProvider: (id: string) =>
			setDraft((current) => selectAiBindingProvider(current, id, context)),
	};
}
