import type { AiProviderAuthKind, ManagedModelCatalogItem } from "@/hosted/billing/contracts";
import {
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	modelIdsForProvider,
	normalizeSelectedProviderIds,
	primaryModelRef,
	providerChoiceFromRef,
	providerRefFromChoice,
} from "@/hosted/v2/ai-providers/model-binding";
import {
	aiProviderRuntimeId,
	buildAiProviderPoolBootstrap,
	type RuntimeAiProviderAuthKind,
	type RuntimeAiProviderBootstrap,
} from "@/hosted/v2/ai-providers/runtime-bootstrap";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export type AiBindingOperationMode = "create" | "update";
export type AiBindingMode = "unmanaged" | "configured";

export type AiProviderBindingDraft = {
	bindingMode: AiBindingMode;
	providerChoices: string[];
	primaryProviderChoice: string;
	primaryModel: string;
};

export type AiBindingFields = {
	ai_provider_auth_kind: AiProviderAuthKind;
	ai_provider_id?: string | null;
	provider_ids?: string[];
	primary_model?: ReturnType<typeof primaryModelRef>;
	ai_provider_bootstrap?: RuntimeAiProviderBootstrap | null;
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
		return mode === "create"
			? { ai_provider_auth_kind: "unmanaged" }
			: {
					ai_provider_auth_kind: "unmanaged",
					ai_provider_id: null,
					provider_ids: [],
					primary_model: null,
					ai_provider_bootstrap: null,
				};
	}

	const selectedChoices = normalizeSelectedProviderIds(
		draft.providerChoices,
		draft.primaryProviderChoice,
	);
	const providerRefs = selectedChoices
		.map((choice) => providerRefFromChoice(choice, providers))
		.filter((providerId): providerId is string => Boolean(providerId));
	if (providerRefs.length !== selectedChoices.length) {
		throw new AiBindingBuildError(
			"Provider unavailable",
			mode === "create"
				? `Refresh providers or choose ${MANAGED_PROVIDER_LABEL}.`
				: "Refresh providers before applying these settings.",
		);
	}

	const primaryProviderRef =
		providerRefFromChoice(draft.primaryProviderChoice, providers) ?? MANAGED_PROVIDER_ID;
	if (
		draft.primaryProviderChoice === MANAGED_AI_CHOICE &&
		!modelIdsForProvider(MANAGED_AI_CHOICE, [], managedModels).includes(draft.primaryModel)
	) {
		throw new AiBindingBuildError(
			"Managed model unavailable",
			mode === "create"
				? "Load the managed model catalog and choose a model before deploying."
				: "Load the managed model catalog and choose a model before applying.",
		);
	}

	const modelRef = primaryModelRef(primaryProviderRef, draft.primaryModel);
	if (!modelRef) {
		throw new AiBindingBuildError(
			"Primary model required",
			mode === "create" ? "Choose a catalog model or enter a model id." : undefined,
		);
	}

	const primaryProvider = providers.find(
		(provider) => provider.provider_id === draft.primaryProviderChoice,
	);
	const customProviders = selectedChoices
		.filter((choice) => choice !== MANAGED_AI_CHOICE)
		.map((choice) => providers.find((provider) => provider.provider_id === choice))
		.filter((provider): provider is AiProvider => Boolean(provider));
	const fields: AiBindingFields = {
		ai_provider_auth_kind: primaryProvider ? providerAuthKind(primaryProvider) : "managed",
		ai_provider_id: primaryProvider ? aiProviderRuntimeId(primaryProvider) : null,
		provider_ids: providerRefs,
		primary_model: modelRef,
	};

	if (customProviders.length > 0) {
		const bootstrapProvider = primaryProvider ?? customProviders[0];
		try {
			fields.ai_provider_bootstrap = buildAiProviderPoolBootstrap(
				customProviders,
				bootstrapProvider.provider_id,
				providerAuthKind(bootstrapProvider),
			);
		} catch (error) {
			throw new AiBindingBuildError(
				mode === "create" ? "Provider unavailable" : "Provider configuration is invalid",
				error instanceof Error ? error.message : "Check provider configuration.",
			);
		}
	} else if (mode === "update") {
		fields.ai_provider_bootstrap = null;
	}

	return fields;
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
		description: error instanceof Error ? error.message : "Check provider configuration.",
	};
}

function providerAuthKind(provider: AiProvider): RuntimeAiProviderAuthKind {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}
