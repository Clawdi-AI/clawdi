import type {
	AiProviderCatalog,
	AiProvider as RuntimeAiProvider,
	AiProviderAuth as RuntimeAiProviderAuth,
	AiProviderModel as RuntimeAiProviderModel,
} from "@clawdi/shared";
import { validateAiProviderCatalog } from "@clawdi/shared";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export type RuntimeAiProviderAuthKind = "api_key" | "codex_oauth";

export interface RuntimeAiProviderBootstrap extends Record<string, unknown> {
	schema_version: 1;
	selected_provider_id: string;
	auth_kind: RuntimeAiProviderAuthKind;
	catalog: AiProviderCatalog;
}

const CAPABILITY_KEYS = [
	"chat",
	"responses",
	"tools",
	"vision",
	"embeddings",
	"image_generation",
] as const;

export function aiProviderRuntimeId(provider: AiProvider): string {
	return provider.provider_id;
}

export function buildAiProviderBootstrap(
	provider: AiProvider,
	authKind: RuntimeAiProviderAuthKind,
): RuntimeAiProviderBootstrap {
	const runtimeProvider = toRuntimeAiProvider(provider);
	const catalog: AiProviderCatalog = {
		schema_version: 1,
		providers: [runtimeProvider],
		defaults: { chat_provider_id: runtimeProvider.id },
	};
	const validation = validateAiProviderCatalog(catalog);
	if (!validation.valid) {
		throw new Error(`Invalid AI provider catalog: ${validation.errors.join("; ")}`);
	}
	return {
		schema_version: 1,
		selected_provider_id: runtimeProvider.id,
		auth_kind: authKind,
		catalog,
	};
}

export function toRuntimeAiProvider(provider: AiProvider): RuntimeAiProvider {
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

function toRuntimeModels(models: AiProvider["models"]): RuntimeAiProviderModel[] {
	if (!models) return [];
	return models.map((model) => {
		const runtimeModel: RuntimeAiProviderModel = { id: model.id };
		if (model.label) runtimeModel.label = model.label;
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
		if (model.cost) runtimeModel.cost = model.cost;
		if (model.capabilities) runtimeModel.capabilities = model.capabilities;
		return runtimeModel;
	});
}

function toRuntimeAuth(auth: AiProvider["auth"]): RuntimeAiProviderAuth {
	if (auth.type === "secret_ref") {
		return { type: "secret_ref", ref: requireAuthString(auth.ref, "secret_ref.ref") };
	}
	if (auth.type === "api_key") {
		if (auth.source !== "env" && auth.source !== "vault" && auth.source !== "managed") {
			throw new Error("Invalid AI provider auth source.");
		}
		if (auth.source === "managed") return { type: "api_key", source: "managed" };
		return {
			type: "api_key",
			source: auth.source,
			ref: requireAuthString(auth.ref, `api_key.${auth.source}.ref`),
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
