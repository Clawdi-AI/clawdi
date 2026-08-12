import type {
	AiProviderApiMode,
	AiProviderAuth,
	AiProviderCatalog,
	AiProviderType,
} from "@clawdi/shared";
import {
	isAiProviderApiMode,
	isAiProviderType,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import type { AgentPrimaryModel } from "../lib/ai-provider-projection";
import { MANAGED_EGRESS_PLACEHOLDER_VALUE } from "./egress-env";
import { isClawdiManagedProviderProjection } from "./hosted-egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";

export function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
): { catalog: AiProviderCatalog; primaryModel: AgentPrimaryModel } | null {
	const providers = manifest.projection?.providers;
	if (!providers || Object.keys(providers).length === 0) return null;
	const rawEntries = hostedProviderEntries(providers, runtimeName, manifest);
	const primaryModel = hostedRuntimePrimaryModel(manifest, runtimeName);
	if (!primaryModel) return null;
	const entries = rawEntries
		.map(([id, raw]) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
			const input = raw as Record<string, unknown>;
			const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : undefined;
			const apiMode = hostedProviderApiMode(input);
			const apiKeySecretRef =
				typeof input.apiKeySecretRef === "string" ? input.apiKeySecretRef : undefined;
			const runtimeEnvName = hostedProviderRuntimeEnvName(id, input, runtimeName);
			if (hostedProviderUnhealthy(input)) return null;
			if (!baseUrl) return null;
			const auth = hostedProviderAuth(input, Boolean(apiKeySecretRef));
			if (!auth) return null;
			const models = hostedProviderModels(
				input,
				id === primaryModel.provider_id ? primaryModel : null,
			);
			return {
				id,
				type: hostedProviderType(input),
				base_url: baseUrl,
				api_mode: apiMode,
				managed_by: hostedProviderManagedBy(input),
				auth,
				runtime_env_name: apiKeySecretRef || auth.type !== "none" ? runtimeEnvName : undefined,
				models,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
	if (entries.length === 0) return null;
	return {
		catalog: {
			schema_version: 1,
			providers: entries,
			defaults: { chat_provider_id: primaryModel.provider_id },
		},
		primaryModel,
	};
}

function hostedProviderManagedBy(
	input: Record<string, unknown>,
): AiProviderCatalog["providers"][number]["managed_by"] {
	const value = input.managed_by;
	return value === "clawdi" || value === "user" ? value : undefined;
}

function hostedProviderEntries(
	providers: Record<string, unknown>,
	runtimeName?: string,
	manifest?: RuntimeManifest,
): Array<[string, unknown]> {
	if (!runtimeName) {
		return Object.entries(providers).sort(([left], [right]) => left.localeCompare(right));
	}
	const providerIds = manifest?.runtimes?.[runtimeName]?.provider_ids ?? [];
	return providerIds
		.filter((providerId) => Object.hasOwn(providers, providerId))
		.map((providerId) => [providerId, providers[providerId]]);
}

function hostedRuntimePrimaryModel(
	manifest: RuntimeManifest,
	runtimeName: string | undefined,
): AgentPrimaryModel | null {
	const runtime = runtimeName ? manifest.runtimes[runtimeName] : undefined;
	return runtime?.primary_model ?? null;
}

function hostedProviderModels(
	input: Record<string, unknown>,
	primaryModel: AgentPrimaryModel | null,
): NonNullable<AiProviderCatalog["providers"][number]["models"]> {
	const providerApiMode = hostedProviderApiMode(input);
	// Hosted wire rejects singular model; this fallback serves generic provider projections only.
	const singularModel = stringValue(input.model);
	const rawModels = Array.isArray(input.models) ? input.models : [];
	const manifestModels = rawModels
		.map((model) => (recordValue(model) ? (model as Record<string, unknown>) : null))
		.filter((model): model is Record<string, unknown> => model !== null)
		.map((model) => {
			const id = stringValue(model.id);
			if (!id) return null;
			const apiMode = stringValue(model.api_mode);
			return {
				...model,
				id,
				...(apiMode && isAiProviderApiMode(apiMode) ? { api_mode: apiMode } : {}),
			};
		})
		.filter((model): model is NonNullable<typeof model> => model !== null);
	// The manifest is the only source: the hosted control plane already
	// intersected curation with Sub2API inventory and froze the result with its
	// facts. Anything not in it is not offered.
	const models = manifestModels;
	if (singularModel && !models.some((model) => model.id === singularModel)) {
		models.unshift({ id: singularModel, api_mode: providerApiMode });
	}
	if (primaryModel && !models.some((model) => model.id === primaryModel.model)) {
		models.unshift({ id: primaryModel.model, api_mode: providerApiMode });
	}
	return models.filter(
		(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
	);
}

function hostedProviderApiMode(input: Record<string, unknown>): AiProviderApiMode {
	const raw = input.apiMode;
	if (typeof raw === "string" && isAiProviderApiMode(raw)) {
		return raw;
	}
	return "openai_chat";
}

function hostedProviderType(input: Record<string, unknown>): AiProviderType {
	const type = stringValue(input.type);
	return type && isAiProviderType(type) ? type : "custom_openai_compatible";
}

function hostedProviderAuth(
	input: Record<string, unknown>,
	hasApiKeySecretRef: boolean,
): AiProviderAuth | null {
	const auth = recordValue(input.auth);
	if (auth) {
		const type = stringValue(auth.type);
		const tool = stringValue(auth.tool);
		const profile = stringValue(auth.profile);
		if (type === "agent_profile" && tool === "codex" && profile) {
			return { type: "agent_profile", tool: "codex", profile };
		}
		if (type === "api_key" || type === "secret_ref") {
			if (hasApiKeySecretRef) {
				return { type: "api_key", source: "managed" };
			}
			return null;
		}
		if (type && type !== "none") return null;
	}
	if (hasApiKeySecretRef) {
		return { type: "api_key", source: "managed" };
	}
	if (hostedProviderRequiresApiKey(input)) {
		return null;
	}
	return { type: "none" };
}

function hostedProviderUnhealthy(input: Record<string, unknown>): boolean {
	const status = stringValue(input.status);
	return Boolean(status && status !== "ok");
}

export function hostedProviderRequiresApiKey(input: Record<string, unknown>): boolean {
	if (input.apiKeyRequired === true) return true;
	const auth = recordValue(input.auth);
	const type = auth ? stringValue(auth.type) : null;
	return type === "api_key" || type === "secret_ref";
}

function hostedProviderRuntimeEnvName(
	providerId: string,
	input: Record<string, unknown>,
	runtimeName?: string,
): string {
	if (
		(runtimeName === "openclaw" || runtimeName === "hermes") &&
		isClawdiManagedProviderProjection(input)
	) {
		return MANAGED_AI_PROVIDER_RUNTIME_ENV;
	}
	const raw = typeof input.runtimeEnvName === "string" ? input.runtimeEnvName : null;
	if (raw && isEnvKey(raw)) return raw;
	return `CLAWDI_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function hostedProviderPlaceholderEnv(
	manifest: RuntimeManifest,
	runtimeName?: string,
): Record<string, string> {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return {};
	const env: Record<string, string> = {};
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName, manifest)) {
		const provider = recordValue(raw);
		if (!provider) continue;
		if (!isClawdiManagedProviderProjection(provider)) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		if (!apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider, runtimeName);
		if (!isEnvKey(runtimeEnvName)) continue;
		env[runtimeEnvName] = MANAGED_EGRESS_PLACEHOLDER_VALUE;
	}
	return env;
}

function hostedProviderSecretEnv(
	manifest: RuntimeManifest,
	runtimeName?: string,
): Record<string, string> {
	const providers = recordValue(manifest.projection?.providers);
	if (!providers) return {};
	const secretEnv: Record<string, string> = {};
	for (const [providerId, raw] of hostedProviderEntries(providers, runtimeName, manifest)) {
		const provider = recordValue(raw);
		if (!provider) continue;
		if (isClawdiManagedProviderProjection(provider)) continue;
		const apiKeySecretRef = stringValue(provider.apiKeySecretRef);
		if (!apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider, runtimeName);
		if (!isEnvKey(runtimeEnvName)) continue;
		secretEnv[runtimeEnvName] = apiKeySecretRef;
	}
	return secretEnv;
}

interface HostedProviderEnvironment {
	placeholderEnv: Record<string, string>;
	secretEnv: Record<string, string>;
}

export function hostedProviderEnvironment(
	manifest: RuntimeManifest,
	runtimeName?: string,
	options: { validateOverlap?: boolean } = {},
): HostedProviderEnvironment {
	const placeholderEnv = hostedProviderPlaceholderEnv(manifest, runtimeName);
	const secretEnv = hostedProviderSecretEnv(manifest, runtimeName);
	if (options.validateOverlap) {
		assertNoProviderEnvOverlap(runtimeName ?? "default", placeholderEnv, secretEnv);
	}
	return { placeholderEnv, secretEnv };
}

function assertNoProviderEnvOverlap(
	runtimeName: string,
	placeholderEnv: Record<string, string>,
	secretEnv: Record<string, string>,
): void {
	for (const envName of Object.keys(placeholderEnv)) {
		if (secretEnv[envName] === undefined) continue;
		throw new Error(
			`runtime ${runtimeName} provider env ${envName} is both managed and BYOK-backed`,
		);
	}
}

export function mergeRuntimeEnvWithProviderPlaceholders(
	runtimeName: string,
	settings: RuntimeManifest["runtimes"][string]["run"],
	providerEnv: Record<string, string>,
): RuntimeManifest["runtimes"][string]["run"] {
	if (Object.keys(providerEnv).length === 0) return settings;
	const userEnv = settings?.env ?? {};
	for (const envName of Object.keys(providerEnv)) {
		if (settings?.secretEnv?.[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName} provider placeholder ${envName} conflicts with secretEnv`,
			);
		}
	}
	return {
		...(settings ?? {}),
		prependPath: settings?.prependPath ?? [],
		env: {
			...userEnv,
			...providerEnv,
		},
	};
}

export function mergeRuntimeServiceEnvWithProviderPlaceholders(
	runtimeName: string,
	serviceName: string,
	settings: NonNullable<RuntimeManifest["runtimes"][string]["services"]>[string],
	providerEnv: Record<string, string>,
): NonNullable<RuntimeManifest["runtimes"][string]["services"]>[string] {
	if (Object.keys(providerEnv).length === 0) return settings;
	for (const envName of Object.keys(providerEnv)) {
		if (settings.secretEnv?.[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName} service ${serviceName} provider placeholder ${envName} conflicts with secretEnv`,
			);
		}
	}
	return {
		...settings,
		env: {
			...(settings.env ?? {}),
			...providerEnv,
		},
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isEnvKey(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
