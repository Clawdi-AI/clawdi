import {
	buildHostedAiBindingFields,
	HostedAiBindingError,
	type HostedAiProviderBootstrap,
} from "@clawdi/shared";
import type { AiProviderAuthKind, ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import {
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_LABEL,
	type primaryModelRef,
	providerChoiceFromRef,
	providerRefFromChoice,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export type AiBindingOperationMode = "create" | "update";
export type AiBindingMode = "unmanaged" | "configured";

export type AiProviderBindingDraft = {
	bindingMode: AiBindingMode;
	primaryProviderChoice: string;
	primaryModel: string;
};

export type AiBindingFields = {
	ai_provider_auth_kind: AiProviderAuthKind;
	ai_provider_id?: string | null;
	provider_ids?: string[];
	primary_model?: ReturnType<typeof primaryModelRef>;
	ai_provider_bootstrap?: HostedAiProviderBootstrap | null;
};

export class AiBindingBuildError extends Error {
	readonly title: string;
	readonly description?: string;

	constructor(title: string, description?: string) {
		super(description ?? title);
		this.name = "AiBindingBuildError";
		this.title = title;
		this.description = description;
	}
}

const UNRESOLVED_PROVIDER_PREFIX = "unresolved:";

export function unresolvedProviderChoice(providerRef: string): string {
	return `${UNRESOLVED_PROVIDER_PREFIX}${providerRef}`;
}

export function isUnresolvedProviderChoice(choice: string): boolean {
	return choice.startsWith(UNRESOLVED_PROVIDER_PREFIX);
}

export function unresolvedProviderRef(choice: string): string {
	return choice.slice(UNRESOLVED_PROVIDER_PREFIX.length);
}

export function updateProviderChoiceFromRef(
	providerRef: string | null | undefined,
	providers: readonly AiProvider[],
): string | null {
	if (!providerRef) return null;
	const choice = providerChoiceFromRef(providerRef, providers);
	if (!choice) return null;
	if (
		choice === MANAGED_AI_CHOICE ||
		providers.some((provider) => provider.provider_id === choice)
	) {
		return choice;
	}
	return unresolvedProviderChoice(providerRef);
}

export function buildAiBindingFields(
	draft: AiProviderBindingDraft,
	{
		managedModels,
		mode,
		providers,
	}: {
		managedModels: readonly ManagedModelCatalogItem[];
		mode: AiBindingOperationMode;
		providers: readonly AiProvider[];
	},
): AiBindingFields {
	if (draft.bindingMode === "unmanaged") {
		return buildHostedAiBindingFields({
			managedModels,
			mode,
			providers,
			selection: { mode: "unmanaged" },
		});
	}

	try {
		if (draft.primaryProviderChoice === MANAGED_AI_CHOICE) {
			return buildHostedAiBindingFields({
				managedModels,
				mode,
				providers,
				selection: { mode: "managed", model: draft.primaryModel },
			});
		}
		const providerId = providerRefFromChoice(draft.primaryProviderChoice, providers);
		if (!providerId) {
			throw new AiBindingBuildError(
				"Provider unavailable",
				mode === "create"
					? `Refresh providers or choose ${MANAGED_PROVIDER_LABEL}.`
					: "Refresh providers before applying these settings.",
			);
		}
		return buildHostedAiBindingFields({
			managedModels,
			mode,
			providers,
			selection: {
				mode: "saved",
				model: draft.primaryModel,
				providerId,
			},
		});
	} catch (error) {
		if (error instanceof HostedAiBindingError) {
			const title =
				error.code === "provider_unusable"
					? "Provider setup required"
					: error.code === "managed_model_unavailable"
						? "Clawdi AI model unavailable"
						: error.code === "model_required"
							? "Primary model required"
							: mode === "create"
								? "Provider unavailable"
								: "Provider configuration is invalid";
			throw new AiBindingBuildError(title, error.message);
		}
		throw error;
	}
}

export function aiBindingBuildErrorCopy(
	error: unknown,
	mode: AiBindingOperationMode,
): { title: string; description?: string } {
	if (error instanceof AiBindingBuildError) {
		return { title: error.title, description: error.description };
	}
	return {
		title: mode === "create" ? "Provider unavailable" : "Provider configuration is invalid",
		description: "Check provider configuration.",
	};
}
