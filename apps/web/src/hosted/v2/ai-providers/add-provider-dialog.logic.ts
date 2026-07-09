import { CODEX_OAUTH_MODEL_CATALOG } from "@clawdi/shared";
import { CLAWDI_CODEX_OAUTH_PROVIDER_ID } from "@/hosted/v2/ai-providers/codex-oauth";
import {
	type ApiMode,
	type ProviderTypeId,
	providerTypeMeta,
	toProviderId,
} from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider, AiProviderAuth, AiProviderUpsert } from "@/hosted/v2/ai-providers/types";

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
}

export function isAuthMethod(value: string | null): value is AuthMethod {
	return value === "api_key" || value === "oauth" || value === "none";
}

export function authFor(method: AuthMethod): AiProviderAuth {
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
}): AiProviderAuth {
	if (authMethod !== "api_key") return authFor(authMethod);
	if (!hasNewManagedKey) {
		const keepable = keepableExistingApiKeyAuth(editingAuth);
		if (keepable) return keepable.auth;
	}
	return authFor("api_key");
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
): AiProviderUpsert["models"] {
	const existingById = new Map((existing ?? []).map((model) => [model.id, model]));
	const models = parseModelIds(input).map((id) => existingById.get(id) ?? { id });
	return models.length > 0 ? models : null;
}

export function derivedProviderFields(
	type: ProviderTypeId,
	authMethod: AuthMethod,
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
	return {
		baseUrl: meta.defaultBaseUrl,
		apiMode: meta.defaultApiMode,
		runtimeEnv: meta.defaultRuntimeEnv,
		modelsText: modelsToText(meta.defaultModels),
	};
}

export function shouldUseCatalogModels(type: ProviderTypeId, authMethod: AuthMethod): boolean {
	return authMethod === "oauth" || providerTypeMeta(type).custom !== true;
}

export function providerFormIdentity({
	type,
	authMethod,
	labelInput,
	existingProviderIds,
	editing,
}: {
	type: ProviderTypeId;
	authMethod: AuthMethod;
	labelInput: string;
	existingProviderIds: readonly string[];
	editing?: Pick<AiProvider, "provider_id" | "label"> | null;
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
		providerTypeMeta(type).custom === true
			? (normalizeLabel(labelInput) ?? defaultProviderLabel(type))
			: defaultProviderLabel(type);
	const baseId = toProviderId(baseLabel);
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
): { kind: ApiKeyKeepKind; auth: AiProviderAuth } | null {
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
