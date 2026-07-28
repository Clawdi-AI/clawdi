import {
	type AiProviderCatalog,
	CLAWDI_MANAGED_PROVIDER_ID,
	type AiProvider as RuntimeAiProvider,
	type AiProviderAuth as RuntimeAiProviderAuth,
	type AiProviderModel as RuntimeAiProviderModel,
	type AiProviderModelCost as RuntimeAiProviderModelCost,
	validateAiProviderCatalog,
} from "../ai-provider";
import type { components } from "./api.generated";
import type { HostedDeployAiFields, HostedDeployManagedModel } from "./deploy-wizard";

type Schemas = components["schemas"];

/** Secret-free provider metadata returned by Cloud's generated API client. */
export type HostedSavedAiProvider = Schemas["AiProviderResponse"];
export type HostedAiProviderAuthKind = "api_key" | "codex_oauth";

export interface HostedAiProviderBootstrap extends Record<string, unknown> {
	schema_version: 1;
	selected_provider_id: string;
	auth_kind: HostedAiProviderAuthKind;
	catalog: AiProviderCatalog;
}

export type HostedAiBindingSelection =
	| { mode: "unmanaged" }
	| { mode: "managed"; model: string; providerIds?: readonly string[] }
	| {
			mode: "saved";
			model: string;
			primaryProviderId: string;
			providerIds: readonly string[];
	  };

export type HostedAiBindingOperationMode = "create" | "update";

export class HostedAiBindingError extends Error {
	readonly code:
		| "invalid_provider_metadata"
		| "managed_model_unavailable"
		| "model_required"
		| "provider_missing"
		| "provider_unusable";

	constructor(code: HostedAiBindingError["code"], message: string) {
		super(message);
		this.name = "HostedAiBindingError";
		this.code = code;
	}
}

const CAPABILITY_KEYS = [
	"chat",
	"responses",
	"tools",
	"vision",
	"embeddings",
	"image_generation",
] as const;

export function hostedAiProviderRuntimeId(provider: HostedSavedAiProvider): string {
	return provider.provider_id;
}

export function hostedAiProviderAuthKind(
	provider: HostedSavedAiProvider,
): HostedAiProviderAuthKind {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}

export function buildHostedAiProviderPoolBootstrap(
	providers: readonly HostedSavedAiProvider[],
	selectedProviderId: string,
	authKind: HostedAiProviderAuthKind,
): HostedAiProviderBootstrap {
	const runtimeProviders = providers.map(toHostedRuntimeAiProvider);
	const selectedProvider = runtimeProviders.find((provider) => provider.id === selectedProviderId);
	if (!selectedProvider) {
		throw new HostedAiBindingError(
			"provider_missing",
			"Selected AI provider is not in the provider pool.",
		);
	}
	const catalog: AiProviderCatalog = {
		schema_version: 1,
		providers: runtimeProviders,
		defaults: { chat_provider_id: selectedProvider.id },
	};
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new HostedAiBindingError(
			"invalid_provider_metadata",
			`Invalid AI provider catalog: ${validation.errors.join("; ")}`,
		);
	}
	return {
		schema_version: 1,
		selected_provider_id: selectedProvider.id,
		auth_kind: authKind,
		catalog,
	};
}

export function toHostedRuntimeAiProvider(provider: HostedSavedAiProvider): RuntimeAiProvider {
	const runtimeProvider: RuntimeAiProvider = {
		id: provider.provider_id,
		type: provider.type,
		base_url: provider.base_url,
		auth: toRuntimeAuth(provider.auth),
		managed_by: provider.managed_by,
	};
	if (provider.label) runtimeProvider.label = provider.label;
	const models = toRuntimeModels(provider.models);
	if (models.length > 0) runtimeProvider.models = models;
	if (provider.api_mode) runtimeProvider.api_mode = provider.api_mode;
	if (provider.runtime_env_name) runtimeProvider.runtime_env_name = provider.runtime_env_name;
	const capabilities = toRuntimeCapabilities(provider.capabilities);
	if (capabilities) runtimeProvider.capabilities = capabilities;
	return runtimeProvider;
}

/** Canonical provider binding used by both Web deploy and the CLI deploy adapter. */
export function buildHostedAiBindingFields({
	managedModels,
	mode,
	providers,
	selection,
}: {
	managedModels: readonly HostedDeployManagedModel[];
	mode: HostedAiBindingOperationMode;
	providers: readonly HostedSavedAiProvider[];
	selection: HostedAiBindingSelection;
}): Omit<HostedDeployAiFields, "primary_model"> & {
	primary_model?: Exclude<HostedDeployAiFields["primary_model"], string>;
	ai_provider_bootstrap?: HostedAiProviderBootstrap | null;
} {
	if (selection.mode === "unmanaged") {
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

	const model = selection.model.trim();
	if (!model) {
		throw new HostedAiBindingError("model_required", "Choose a catalog model or enter a model id.");
	}

	if (selection.mode === "managed") {
		if (managedModels.length === 0 || !managedModels.some((item) => item.id === model)) {
			throw new HostedAiBindingError(
				"managed_model_unavailable",
				"Load the managed model catalog and choose a model before deploying.",
			);
		}
		const providerIds = selectedProviderIds(
			selection.providerIds ?? [CLAWDI_MANAGED_PROVIDER_ID],
			CLAWDI_MANAGED_PROVIDER_ID,
		);
		const customProviders = savedProvidersForIds(providerIds, providers);
		const fields: ReturnType<typeof buildHostedAiBindingFields> = {
			ai_provider_auth_kind: "managed",
			ai_provider_id: null,
			provider_ids: providerIds,
			primary_model: { provider_id: CLAWDI_MANAGED_PROVIDER_ID, model },
		};
		if (customProviders.length > 0) {
			const bootstrapProvider = customProviders[0];
			if (!bootstrapProvider) {
				throw new HostedAiBindingError("provider_missing", "The provider pool is unavailable.");
			}
			const authKind = hostedAiProviderAuthKind(bootstrapProvider);
			fields.ai_provider_bootstrap = buildHostedAiProviderPoolBootstrap(
				customProviders,
				bootstrapProvider.provider_id,
				authKind,
			);
		} else if (mode === "update") {
			fields.ai_provider_bootstrap = null;
		}
		return fields;
	}

	const providerIds = selectedProviderIds(selection.providerIds, selection.primaryProviderId);
	const selectedProviders = savedProvidersForIds(providerIds, providers);
	const primaryProvider = selectedProviders.find(
		(provider) => provider.provider_id === selection.primaryProviderId,
	);
	if (!primaryProvider) {
		throw new HostedAiBindingError("provider_missing", "The primary AI provider is unavailable.");
	}
	const authKind = hostedAiProviderAuthKind(primaryProvider);
	return {
		ai_provider_auth_kind: authKind,
		ai_provider_id: primaryProvider.provider_id,
		provider_ids: providerIds,
		primary_model: { provider_id: primaryProvider.provider_id, model },
		ai_provider_bootstrap: buildHostedAiProviderPoolBootstrap(
			selectedProviders,
			primaryProvider.provider_id,
			authKind,
		),
	};
}

function selectedProviderIds(providerIds: readonly string[], primaryProviderId: string): string[] {
	const selected = dedupeProviderIds(providerIds);
	if (!selected.includes(primaryProviderId)) selected.unshift(primaryProviderId);
	return selected;
}

function savedProvidersForIds(
	providerIds: readonly string[],
	providers: readonly HostedSavedAiProvider[],
): HostedSavedAiProvider[] {
	return providerIds
		.filter((providerId) => providerId !== CLAWDI_MANAGED_PROVIDER_ID)
		.map((providerId) => {
			const provider = providers.find((candidate) => candidate.provider_id === providerId);
			if (!provider) {
				throw new HostedAiBindingError(
					"provider_missing",
					`Saved AI provider ${providerId} is unavailable. Refresh providers or choose another provider.`,
				);
			}
			if (!provider.usable) {
				throw new HostedAiBindingError(
					"provider_unusable",
					`${provider.label?.trim() || provider.provider_id} has no usable credential. Finish its setup or choose another provider.`,
				);
			}
			return provider;
		});
}

function dedupeProviderIds(providerIds: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of providerIds) {
		const providerId = value.trim();
		if (!providerId || seen.has(providerId)) continue;
		seen.add(providerId);
		result.push(providerId);
	}
	return result;
}

function toRuntimeModels(models: HostedSavedAiProvider["models"]): RuntimeAiProviderModel[] {
	if (!models) return [];
	return models.map((model) => {
		const runtimeModel: RuntimeAiProviderModel = { id: model.id };
		if (model.label) runtimeModel.label = model.label;
		if (model.alias) runtimeModel.alias = model.alias;
		if (model.api_mode) runtimeModel.api_mode = model.api_mode;
		if (model.input_modalities) runtimeModel.input_modalities = model.input_modalities;
		if (model.supports_reasoning !== null && model.supports_reasoning !== undefined) {
			runtimeModel.supports_reasoning = model.supports_reasoning;
		}
		if (model.context_window !== null && model.context_window !== undefined) {
			runtimeModel.context_window = model.context_window;
		}
		if (model.max_tokens !== null && model.max_tokens !== undefined) {
			runtimeModel.max_tokens = model.max_tokens;
		}
		const cost = toRuntimeModelCost(model.cost);
		if (cost) runtimeModel.cost = cost;
		if (model.capabilities) runtimeModel.capabilities = model.capabilities;
		return runtimeModel;
	});
}

function toRuntimeModelCost(
	cost: NonNullable<HostedSavedAiProvider["models"]>[number]["cost"],
): RuntimeAiProviderModelCost | undefined {
	if (!cost) return undefined;
	const runtimeCost: RuntimeAiProviderModelCost = { input: cost.input, output: cost.output };
	if (cost.cache_read !== null && cost.cache_read !== undefined) {
		runtimeCost.cache_read = cost.cache_read;
	}
	if (cost.cache_write !== null && cost.cache_write !== undefined) {
		runtimeCost.cache_write = cost.cache_write;
	}
	return runtimeCost;
}

function toRuntimeAuth(auth: HostedSavedAiProvider["auth"]): RuntimeAiProviderAuth {
	if (auth.type === "secret_ref") {
		return { type: "secret_ref", ref: requireAuthString(auth.ref, "secret_ref.ref") };
	}
	if (auth.type === "api_key") {
		if (auth.source !== "env" && auth.source !== "vault" && auth.source !== "managed") {
			throw new Error("Invalid AI provider auth source.");
		}
		const profile = auth.profile ?? undefined;
		if (auth.source === "managed") {
			return profile
				? { type: "api_key", source: "managed", profile }
				: { type: "api_key", source: "managed" };
		}
		return {
			type: "api_key",
			source: auth.source,
			ref: requireAuthString(auth.ref, `api_key.${auth.source}.ref`),
			...(profile ? { profile } : {}),
		};
	}
	if (auth.type === "oauth_profile") {
		return {
			type: "oauth_profile",
			provider: requireAuthString(auth.provider, "oauth_profile.provider"),
			profile: requireAuthString(auth.profile, "oauth_profile.profile"),
		};
	}
	if (auth.type === "agent_profile") {
		return {
			type: "agent_profile",
			tool: requireAuthString(auth.tool, "agent_profile.tool"),
			profile: requireAuthString(auth.profile, "agent_profile.profile"),
		};
	}
	if (auth.type === "none") return { type: "none" };
	throw new Error("Unsupported AI provider auth type.");
}

function requireAuthString(value: string | null | undefined, field: string): string {
	if (!value) throw new Error(`Invalid AI provider auth metadata: missing ${field}.`);
	return value;
}

function toRuntimeCapabilities(
	capabilities: Record<string, unknown> | null | undefined,
): RuntimeAiProvider["capabilities"] | undefined {
	if (!capabilities) return undefined;
	const output: RuntimeAiProvider["capabilities"] = {};
	for (const key of CAPABILITY_KEYS) {
		const value = capabilities[key];
		if (typeof value === "boolean") output[key] = value;
	}
	return Object.keys(output).length > 0 ? output : undefined;
}
