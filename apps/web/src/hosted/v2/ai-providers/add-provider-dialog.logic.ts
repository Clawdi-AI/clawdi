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
	AiProviderUpsert,
	AiProviderUpsertAuth,
} from "@/hosted/v2/ai-providers/types";

export type AuthMethod = "api_key" | "oauth";

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

export function authFor(method: AuthMethod): AiProviderUpsertAuth {
	if (method === "api_key") return { type: "api_key", source: "managed" };
	return { type: "agent_profile", tool: "codex", profile: "default" };
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
	if (editing) {
		return {
			providerId: editing.provider_id,
			label: normalizeLabel(labelInput) ?? editing.label ?? null,
		};
	}
	if (authMethod === "oauth") {
		const baseId = CLAWDI_CODEX_OAUTH_PROVIDER_ID;
		const baseLabel = "ChatGPT (Codex)";
		let suffix = 1;
		while (existingProviderIds.includes(suffix === 1 ? baseId : `${baseId}-${suffix}`)) {
			suffix += 1;
		}
		return {
			providerId: suffix === 1 ? baseId : `${baseId}-${suffix}`,
			label: suffix === 1 ? baseLabel : `${baseLabel} ${suffix}`,
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

function normalizeLabel(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function defaultProviderLabel(type: ProviderTypeId): string {
	if (type === "custom_openai_compatible") return "Custom endpoint";
	return providerTypeMeta(type).label;
}
