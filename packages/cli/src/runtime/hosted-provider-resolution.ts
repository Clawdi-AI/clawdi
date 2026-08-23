import type { AiProviderAuth, AiProviderCatalog } from "@clawdi/shared";
import {
	CLAWDI_MANAGED_PROVIDER_ID,
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_API_MODE,
	isClawdiManagedV2ProviderId,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import type { AgentPrimaryModel } from "../lib/ai-provider-projection";
import { MANAGED_EGRESS_PLACEHOLDER_VALUE } from "./egress-env";
import { isClawdiManagedProviderProjection } from "./hosted-egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";

export type HostedAiProviderProjectionInput = {
	catalog: AiProviderCatalog;
	primaryModel: AgentPrimaryModel;
};

type HostedProviderProjection = NonNullable<
	NonNullable<RuntimeManifest["projection"]>["providers"]
>[string];

export function agentTargetProjectionInput(
	input: HostedAiProviderProjectionInput | null,
): HostedAiProviderProjectionInput | null {
	if (!input) return null;
	const providerIdMap = new Map<string, string>();
	const providers = input.catalog.providers.map((provider) => {
		if (provider.managed_by !== "clawdi") return provider;
		const id = isClawdiManagedV2ProviderId(provider.id)
			? CLAWDI_MANAGED_PROVIDER_ID
			: provider.id === CLAWDI_MANAGED_V1_PROVIDER_ID || provider.id.startsWith("clawdi-managed")
				? provider.id
				: CLAWDI_MANAGED_V1_PROVIDER_ID;
		providerIdMap.set(provider.id, id);
		return {
			...provider,
			id,
			api_mode: isClawdiManagedV2ProviderId(id) ? CLAWDI_MANAGED_V2_API_MODE : provider.api_mode,
		} satisfies AiProviderCatalog["providers"][number];
	});
	const primaryProviderId = providerIdMap.get(input.primaryModel.provider_id);
	if (!primaryProviderId) return input;
	return {
		catalog: {
			...input.catalog,
			providers,
			defaults: { ...input.catalog.defaults, chat_provider_id: primaryProviderId },
		},
		primaryModel: { ...input.primaryModel, provider_id: primaryProviderId },
	};
}

export function hostedAiProviderCatalog(
	manifest: RuntimeManifest,
	runtimeName?: string,
): { catalog: AiProviderCatalog; primaryModel: AgentPrimaryModel } | null {
	const providers = manifest.projection?.providers;
	if (!providers || Object.keys(providers).length === 0) return null;
	const providerEntries = hostedProviderEntries(providers, runtimeName, manifest);
	const primaryModel = hostedRuntimePrimaryModel(manifest, runtimeName);
	if (!primaryModel) return null;
	const entries = providerEntries
		.map(([id, input]) => {
			const baseUrl = input.baseUrl;
			const apiMode = hostedProviderApiMode(input);
			const apiKeySecretRef = input.apiKeySecretRef ?? undefined;
			const runtimeEnvName = hostedProviderRuntimeEnvName(id, input, runtimeName);
			if (input.status === "error") return null;
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
				managed_by: input.managed_by,
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

function hostedProviderEntries(
	providers: Record<string, HostedProviderProjection>,
	runtimeName?: string,
	manifest?: RuntimeManifest,
): Array<[string, HostedProviderProjection]> {
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
	input: HostedProviderProjection,
	primaryModel: AgentPrimaryModel | null,
): NonNullable<AiProviderCatalog["providers"][number]["models"]> {
	const providerApiMode = hostedProviderApiMode(input);
	// The manifest is the only source: the hosted control plane already
	// intersected curation with Sub2API inventory and froze the result with its
	// facts. Anything not in it is not offered.
	const models = [...(input.models ?? [])];
	if (input.model && !models.some((model) => model.id === input.model)) {
		models.unshift({ id: input.model, api_mode: providerApiMode });
	}
	if (primaryModel && !models.some((model) => model.id === primaryModel.model)) {
		models.unshift({ id: primaryModel.model, api_mode: providerApiMode });
	}
	return models.filter(
		(model, index, entries) => entries.findIndex((entry) => entry.id === model.id) === index,
	);
}

function hostedProviderApiMode(
	input: HostedProviderProjection,
): AiProviderCatalog["providers"][number]["api_mode"] {
	return input.apiMode ?? "openai_chat";
}

function hostedProviderType(
	input: HostedProviderProjection,
): AiProviderCatalog["providers"][number]["type"] {
	return input.type ?? "custom_openai_compatible";
}

function hostedProviderAuth(
	input: HostedProviderProjection,
	hasApiKeySecretRef: boolean,
): AiProviderAuth | null {
	const auth = input.auth;
	if (auth) {
		if (auth.type === "agent_profile" && auth.tool === "codex" && auth.profile) {
			return { type: "agent_profile", tool: "codex", profile: auth.profile };
		}
		if (auth.type === "api_key" || auth.type === "secret_ref") {
			if (hasApiKeySecretRef) {
				return { type: "api_key", source: "managed" };
			}
			return null;
		}
		if (auth.type !== "none") return null;
	}
	if (hasApiKeySecretRef) {
		return { type: "api_key", source: "managed" };
	}
	if (hostedProviderRequiresApiKey(input)) {
		return null;
	}
	return { type: "none" };
}

export function hostedProviderRequiresApiKey(input: Record<string, unknown>): boolean {
	if (input.apiKeyRequired === true) return true;
	const auth = recordValue(input.auth);
	return auth?.type === "api_key" || auth?.type === "secret_ref";
}

function hostedProviderRuntimeEnvName(
	providerId: string,
	input: HostedProviderProjection,
	runtimeName?: string,
): string {
	if (
		(runtimeName === "openclaw" || runtimeName === "hermes") &&
		isClawdiManagedProviderProjection(input)
	) {
		return MANAGED_AI_PROVIDER_RUNTIME_ENV;
	}
	const raw = input.runtimeEnvName;
	if (raw && isEnvKey(raw)) return raw;
	return `CLAWDI_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
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
	const placeholderEnv: Record<string, string> = {};
	const secretEnv: Record<string, string> = {};
	for (const [providerId, provider] of hostedProviderEntries(
		manifest.projection?.providers ?? {},
		runtimeName,
		manifest,
	)) {
		if (!provider.apiKeySecretRef) continue;
		const runtimeEnvName = hostedProviderRuntimeEnvName(providerId, provider, runtimeName);
		if (!isEnvKey(runtimeEnvName)) continue;
		if (isClawdiManagedProviderProjection(provider)) {
			placeholderEnv[runtimeEnvName] = MANAGED_EGRESS_PLACEHOLDER_VALUE;
		} else {
			secretEnv[runtimeEnvName] = provider.apiKeySecretRef;
		}
	}
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

type RuntimeProviderSettings = RuntimeManifest["runtimes"][string]["run"];
type RuntimeServiceProviderSettings = NonNullable<
	RuntimeManifest["runtimes"][string]["services"]
>[string];

export function mergeRuntimeEnvWithProviderPlaceholders(
	runtimeName: string,
	settings: RuntimeServiceProviderSettings,
	providerEnv: Record<string, string>,
	serviceName: string,
): RuntimeServiceProviderSettings;
export function mergeRuntimeEnvWithProviderPlaceholders(
	runtimeName: string,
	settings: RuntimeProviderSettings,
	providerEnv: Record<string, string>,
): RuntimeProviderSettings;
export function mergeRuntimeEnvWithProviderPlaceholders(
	runtimeName: string,
	settings: RuntimeProviderSettings | RuntimeServiceProviderSettings,
	providerEnv: Record<string, string>,
	serviceName?: string,
): RuntimeProviderSettings | RuntimeServiceProviderSettings {
	if (Object.keys(providerEnv).length === 0) return settings;
	const userEnv = settings?.env ?? {};
	for (const envName of Object.keys(providerEnv)) {
		if (settings?.secretEnv?.[envName] !== undefined) {
			throw new Error(
				`runtime ${runtimeName}${serviceName ? ` service ${serviceName}` : ""} provider placeholder ${envName} conflicts with secretEnv`,
			);
		}
	}
	return {
		...(settings ?? {}),
		prependPath: settings?.prependPath ?? [],
		env: { ...userEnv, ...providerEnv },
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isEnvKey(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
