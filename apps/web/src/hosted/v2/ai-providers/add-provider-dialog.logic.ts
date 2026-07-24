import { CODEX_OAUTH_MODEL_CATALOG } from "@clawdi/shared";
import { CLAWDI_CODEX_OAUTH_PROVIDER_ID } from "@/hosted/v2/ai-providers/codex-oauth";
import {
	type ProviderPreset,
	presetCatalogToProviderModels,
	presetRuntimeEnvName,
} from "@/hosted/v2/ai-providers/provider-presets";
import {
	type ApiMode,
	type ProviderTypeId,
	providerTypeMeta,
	toProviderId,
} from "@/hosted/v2/ai-providers/provider-types";
import type {
	AiProvider,
	AiProviderAuth,
	AiProviderPatch,
	AiProviderUpsert,
	AiProviderUpsertAuth,
} from "@/hosted/v2/ai-providers/types";

export type AuthMethod = "api_key" | "oauth" | "none";

export type ApiKeyKeepKind = "managed" | "env" | "vault" | "legacy_secret_ref";

export interface ApiKeyEditState {
	canKeepManagedApiKey: boolean;
	canKeepLegacySecretRef: boolean;
	canKeepExternalApiKeyRef: boolean;
	canKeepExistingKey: boolean;
	keyRequired: boolean;
	labelSuffix: string;
	helpText: string;
}

export interface ProviderFormIdentity {
	providerId: string;
	label: string | null;
}

export interface DerivedProviderFields {
	baseUrl: string;
	apiMode: ApiMode;
	runtimeEnv: string;
	modelsText: string;
	suggestedPrimaryModel?: string;
}

export function isAuthMethod(value: string | null): value is AuthMethod {
	return value === "api_key" || value === "oauth" || value === "none";
}

export function authFor(method: AuthMethod): AiProviderUpsertAuth {
	if (method === "api_key") return { type: "api_key", source: "managed" };
	if (method === "oauth") return { type: "agent_profile", tool: "codex", profile: "default" };
	return { type: "none" };
}

export function apiKeyEditState(
	authMethod: AuthMethod,
	editingAuth: AiProviderAuth | null | undefined,
): ApiKeyEditState {
	const keepable = keepableExistingApiKeyAuth(editingAuth);
	const keepKind = authMethod === "api_key" ? keepable?.kind : undefined;
	const canKeepExistingKey = keepKind !== undefined;
	return {
		canKeepManagedApiKey: keepKind === "managed",
		canKeepLegacySecretRef: keepKind === "legacy_secret_ref",
		canKeepExternalApiKeyRef: keepKind === "env" || keepKind === "vault",
		canKeepExistingKey,
		keyRequired: authMethod === "api_key" && !canKeepExistingKey,
		labelSuffix: apiKeyLabelSuffix(keepKind),
		helpText: apiKeyHelpText(keepKind),
	};
}

export function providerAuthForSubmit({
	authMethod,
	editingAuth,
	hasNewManagedKey,
}: {
	authMethod: AuthMethod;
	editingAuth: AiProviderAuth | null | undefined;
	hasNewManagedKey: boolean;
}): AiProviderUpsertAuth {
	if (authMethod !== "api_key") return authFor(authMethod);
	if (!hasNewManagedKey) {
		const keepable = keepableExistingApiKeyAuth(editingAuth);
		if (keepable) return keepable.auth;
	}
	return authFor("api_key");
}

export function providerPatchForSubmit(
	body: AiProviderUpsert,
	options: { preserveExistingAuth: boolean },
): AiProviderPatch {
	const patch: AiProviderPatch = {
		type: body.type,
		label: body.label,
		base_url: body.base_url,
		api_mode: body.api_mode,
		managed_by: body.managed_by,
		runtime_env_name: body.runtime_env_name,
		capabilities: body.capabilities,
		models: body.models,
	};
	if (!options.preserveExistingAuth) patch.auth = body.auth;
	return patch;
}

/** Restore every editable field exposed by the provider response. */
export function providerRollbackPatch(provider: AiProvider): AiProviderPatch {
	const patch: AiProviderPatch = {
		type: provider.type,
		label: provider.label,
		base_url: provider.base_url,
		api_mode: provider.api_mode,
		managed_by: provider.managed_by,
		runtime_env_name: provider.runtime_env_name,
		capabilities: provider.capabilities,
		models: provider.models,
	};
	// oauth_profile is a response-only legacy auth shape. For every editable
	// auth shape, restore the prior source as well as the provider fields.
	if (provider.auth.type !== "oauth_profile") patch.auth = provider.auth;
	return patch;
}

export function providerListAllowsSubmit(isEdit: boolean, listLoaded: boolean): boolean {
	return isEdit || listLoaded;
}

export function modelsToText(models: ReadonlyArray<{ id: string }> | null | undefined): string {
	return (models ?? []).map((model) => model.id).join("\n");
}

export function parseModelIds(input: string): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const raw of input.split(/[,\n]/)) {
		const id = raw.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

export function modelsFromText(
	input: string,
	existing: AiProvider["models"],
	catalog: AiProvider["models"] = [],
): AiProviderUpsert["models"] {
	type UpsertModel = NonNullable<AiProviderUpsert["models"]>[number];
	const knownById = new Map<string, UpsertModel>();
	for (const model of catalog ?? []) {
		knownById.set(model.id, model);
	}
	for (const model of existing ?? []) {
		knownById.set(model.id, model);
	}
	const models = parseModelIds(input).map((id) => knownById.get(id) ?? { id });
	return models.length > 0 ? models : null;
}

export function derivedProviderFields(
	type: ProviderTypeId,
	authMethod: AuthMethod,
	preset?: ProviderPreset | null,
): DerivedProviderFields {
	const meta = providerTypeMeta(type);
	if (authMethod === "oauth") {
		return {
			baseUrl: providerTypeMeta("openai").defaultBaseUrl,
			apiMode: "openai_responses",
			runtimeEnv: providerTypeMeta("openai").defaultRuntimeEnv,
			modelsText: modelsToText(CODEX_OAUTH_MODEL_CATALOG),
		};
	}
	if (preset) {
		return {
			baseUrl: preset.base_url,
			apiMode: preset.api_mode,
			runtimeEnv: presetRuntimeEnvName(preset),
			modelsText: modelsToText(presetCatalogToProviderModels(preset)),
			suggestedPrimaryModel: preset.suggested_primary_model,
		};
	}
	return {
		baseUrl: meta.defaultBaseUrl,
		apiMode: meta.defaultApiMode,
		runtimeEnv: meta.defaultRuntimeEnv,
		modelsText: modelsToText(meta.defaultModels),
	};
}

export function shouldUseCatalogModels(
	type: ProviderTypeId,
	authMethod: AuthMethod,
	preset?: ProviderPreset | null,
): boolean {
	if (preset) return true;
	return authMethod === "oauth" || providerTypeMeta(type).custom !== true;
}

export function providerFormIdentity({
	type,
	authMethod,
	labelInput,
	existingProviderIds,
	editing,
	preset,
}: {
	type: ProviderTypeId;
	authMethod: AuthMethod;
	labelInput: string;
	existingProviderIds: readonly string[];
	editing?: Pick<AiProvider, "provider_id" | "label"> | null;
	preset?: ProviderPreset | null;
}): ProviderFormIdentity {
	if (authMethod === "oauth") {
		return {
			providerId: CLAWDI_CODEX_OAUTH_PROVIDER_ID,
			label: "Codex (ChatGPT)",
		};
	}
	if (editing) {
		return {
			providerId: editing.provider_id,
			label: normalizeLabel(labelInput) ?? null,
		};
	}
	const baseLabel =
		preset?.label ??
		(providerTypeMeta(type).custom === true
			? (normalizeLabel(labelInput) ?? defaultProviderLabel(type))
			: defaultProviderLabel(type));
	const baseId = toProviderId(preset?.id ?? baseLabel);
	if (!baseId) return { providerId: "", label: baseLabel };
	if (!existingProviderIds.includes(baseId)) {
		return { providerId: baseId, label: baseLabel };
	}
	let suffix = 2;
	while (existingProviderIds.includes(`${baseId}-${suffix}`)) {
		suffix += 1;
	}
	return {
		providerId: `${baseId}-${suffix}`,
		label: `${baseLabel} ${suffix}`,
	};
}

function keepableExistingApiKeyAuth(
	auth: AiProviderAuth | null | undefined,
): { kind: ApiKeyKeepKind; auth: AiProviderUpsertAuth } | null {
	if (!auth) return null;
	if (auth.type === "secret_ref" && auth.ref) return { kind: "legacy_secret_ref", auth };
	if (auth.type !== "api_key") return null;
	if (auth.source === "managed") return { kind: "managed", auth };
	if ((auth.source === "env" || auth.source === "vault") && auth.ref) {
		return { kind: auth.source, auth };
	}
	return null;
}

function apiKeyLabelSuffix(kind: ApiKeyKeepKind | undefined): string {
	if (!kind) return "";
	if (kind === "managed") return " (leave blank to keep)";
	if (kind === "legacy_secret_ref") return " (leave blank to keep legacy reference)";
	return ` (leave blank to keep current ${kind} reference)`;
}

function apiKeyHelpText(kind: ApiKeyKeepKind | undefined): string {
	if (kind === "legacy_secret_ref") {
		return "Leave blank to preserve this provider's existing legacy secret reference. Enter a key to switch it to managed API-key auth.";
	}
	if (kind === "env" || kind === "vault") {
		return `Leave blank to keep the current ${kind} reference. Enter a key to switch it to managed API-key auth.`;
	}
	if (kind === "managed") {
		return "Leave blank to keep the current managed key. Enter a key to replace it.";
	}
	return "Stored encrypted for the hosted runtime and delivered as a manifest secret. The dashboard will not show it again.";
}

function normalizeLabel(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function defaultProviderLabel(type: ProviderTypeId): string {
	if (type === "custom_openai_compatible") return "Custom endpoint";
	return providerTypeMeta(type).label;
}
