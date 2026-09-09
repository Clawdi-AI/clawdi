import {
	isFirstPartyManagedAiProvider,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
	nativeAiProvider,
} from "@clawdi/shared";
import { CLAWDI_CODEX_OAUTH_PROVIDER_ID } from "@/hosted/v2/ai-providers/codex-oauth";
import {
	type ProviderPreset,
	providerPresetForSavedProvider,
} from "@/hosted/v2/ai-providers/provider-presets";
import {
	type ApiMode,
	type ProviderTypeId,
	providerTypeMeta,
	toProviderId,
} from "@/hosted/v2/ai-providers/provider-types";
import type {
	AiProvider,
	AiProviderPatch,
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
}

export function authFor(method: AuthMethod): AiProviderUpsertAuth {
	if (method === "api_key") return { type: "api_key", source: "managed" };
	return { type: "agent_profile", tool: "codex", profile: "default" };
}

export function providerListAllowsSubmit(isEdit: boolean, listLoaded: boolean): boolean {
	return isEdit || listLoaded;
}

export function customProviderRuntimeEnv(
	providerId: string,
	existing: readonly Pick<AiProvider, "runtime_env_name">[],
): string {
	const base = `CLAWDI_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
	const names = new Set([
		MANAGED_AI_PROVIDER_RUNTIME_ENV,
		...existing.map((provider) => provider.runtime_env_name),
	]);
	let name = base;
	for (let suffix = 2; names.has(name); suffix += 1) name = `${base}_${suffix}`;
	return name;
}

/** Only changed display/routing fields are editable; stored models and auth are not form state. */
export function providerSettingsPatch(
	provider: Pick<AiProvider, "type" | "base_url" | "api_mode" | "native_variant" | "auth">,
	fields: Pick<
		AiProviderUpsert,
		"label" | "base_url" | "api_mode" | "configuration_mode" | "native_variant"
	>,
): AiProviderPatch {
	const patch: AiProviderPatch = { label: fields.label };
	if (fields.base_url !== provider.base_url) patch.base_url = fields.base_url;
	const currentApiMode =
		provider.api_mode ??
		derivedProviderFields(
			provider.type,
			provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
				? "oauth"
				: "api_key",
			providerPresetForSavedProvider({ baseUrl: provider.base_url }),
		).apiMode;
	if (fields.api_mode !== currentApiMode) patch.api_mode = fields.api_mode;
	if (
		fields.configuration_mode === "native" &&
		(fields.native_variant ?? null) !== (provider.native_variant ?? null)
	) {
		patch.native_variant = fields.native_variant;
	}
	return patch;
}

/** Connection edits never carry stored model metadata or change credential identity. */
export function connectionProviderPatch(
	provider: AiProvider,
	fields: { label: string | null; baseUrl: string; apiMode: ApiMode; apiKey: string },
): AiProviderPatch {
	if (provider.configuration_mode !== "connection" && provider.configuration_mode !== "custom")
		throw new Error("Expected an existing connection");
	return {
		...providerSettingsPatch(provider, {
			label: fields.label,
			base_url: fields.baseUrl.trim(),
			api_mode: fields.apiMode,
		}),
		...(fields.apiKey.trim()
			? { credential: { type: "api_key", value: fields.apiKey.trim() } }
			: {}),
	};
}

export function derivedProviderFields(
	type: ProviderTypeId,
	authMethod: AuthMethod,
	preset?: ProviderPreset | null,
): DerivedProviderFields {
	const route = nativeAiProvider(authMethod === "oauth" ? "openai-codex" : (preset?.id ?? type));
	const meta = providerTypeMeta(type);
	return {
		baseUrl: route?.base_url ?? preset?.base_url ?? meta.defaultBaseUrl,
		apiMode: route?.api_mode ?? preset?.api_mode ?? meta.defaultApiMode,
	};
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
	const requestedLabel = normalizeLabel(labelInput);
	const baseLabel =
		authMethod === "oauth"
			? "ChatGPT (Codex)"
			: (preset?.label ??
				(providerTypeMeta(type).custom
					? (requestedLabel ?? "Custom provider")
					: providerTypeMeta(type).label));
	let baseId =
		authMethod === "oauth"
			? CLAWDI_CODEX_OAUTH_PROVIDER_ID
			: toProviderId(preset?.id ?? baseLabel) || "custom";
	if (isFirstPartyManagedAiProvider({ provider_id: baseId }))
		baseId = toProviderId(`custom-${baseId}`);
	const taken = new Set(existingProviderIds);
	let providerId = baseId;
	let suffix = 1;
	while (taken.has(providerId)) {
		suffix += 1;
		const ending = `-${suffix}`;
		providerId = `${baseId.slice(0, 63 - ending.length)}${ending}`;
	}
	return {
		providerId,
		label: requestedLabel ?? (suffix === 1 ? baseLabel : `${baseLabel} ${suffix}`),
	};
}

function normalizeLabel(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}
