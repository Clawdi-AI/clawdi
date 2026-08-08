import type { AiProviderModel as CatalogAiProviderModel } from "@clawdi/shared";
import {
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	defaultAiProviderModels,
	defaultAiProviderRuntimeEnvName,
} from "@clawdi/shared";
import type { AiProvider, AiProviderUpsert } from "@/hosted/v2/ai-providers/types";

/**
 * The six AI provider types (backend `ProviderType`) with the defaults the
 * add flow prefills: base URL, allowed API modes, runtime env var, and a
 * model placeholder.
 */
export const PROVIDER_TYPES = [
	"openai",
	"anthropic",
	"openrouter",
	"gemini",
	"mistral",
	"custom_openai_compatible",
] as const;
export type ProviderTypeId = (typeof PROVIDER_TYPES)[number];

export type ApiMode = NonNullable<AiProviderUpsert["api_mode"]>;

export type ProviderCatalogModel = NonNullable<AiProvider["models"]>[number];

export interface ProviderTypeMeta {
	id: ProviderTypeId;
	label: string;
	defaultBaseUrl: string;
	apiModes: ApiMode[];
	defaultApiMode: ApiMode;
	defaultRuntimeEnv: string;
	modelPlaceholder: string;
	defaultModels: readonly ProviderCatalogModel[];
	apiKeyUrl?: string;
	/** base_url + api_mode are user-supplied / required. */
	custom?: boolean;
	/** Offers "Sign in with ChatGPT" (Codex OAuth). */
	oauth?: boolean;
}

const CUSTOM_OPENAI_COMPATIBLE_RUNTIME_ENV = "CUSTOM_API_KEY";
const CUSTOM_OPENAI_COMPATIBLE_MODEL_PLACEHOLDER = "model name";

export const PROVIDER_TYPE_META: Record<ProviderTypeId, ProviderTypeMeta> = {
	openai: {
		id: "openai",
		label: "OpenAI",
		defaultBaseUrl: defaultAiProviderBaseUrl("openai") ?? "",
		apiModes: ["openai_chat", "openai_responses"],
		defaultApiMode: defaultAiProviderApiMode("openai") ?? "openai_responses",
		defaultRuntimeEnv: defaultAiProviderRuntimeEnvName("openai") ?? "",
		modelPlaceholder: defaultAiProviderModels("openai")[0]?.id ?? "",
		defaultModels: toProviderCatalogModels(defaultAiProviderModels("openai")),
		apiKeyUrl: "https://platform.openai.com/settings/organization/api-keys",
		oauth: true,
	},
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		defaultBaseUrl: defaultAiProviderBaseUrl("anthropic") ?? "",
		apiModes: ["anthropic_messages"],
		defaultApiMode: defaultAiProviderApiMode("anthropic") ?? "anthropic_messages",
		defaultRuntimeEnv: defaultAiProviderRuntimeEnvName("anthropic") ?? "",
		modelPlaceholder: defaultAiProviderModels("anthropic")[0]?.id ?? "",
		defaultModels: toProviderCatalogModels(defaultAiProviderModels("anthropic")),
		apiKeyUrl: "https://platform.claude.com/settings/keys",
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter",
		defaultBaseUrl: defaultAiProviderBaseUrl("openrouter") ?? "",
		apiModes: ["openai_chat"],
		defaultApiMode: defaultAiProviderApiMode("openrouter") ?? "openai_chat",
		defaultRuntimeEnv: defaultAiProviderRuntimeEnvName("openrouter") ?? "",
		modelPlaceholder: defaultAiProviderModels("openrouter")[0]?.id ?? "",
		defaultModels: toProviderCatalogModels(defaultAiProviderModels("openrouter")),
		apiKeyUrl: "https://openrouter.ai/keys",
	},
	gemini: {
		id: "gemini",
		label: "Google Gemini",
		defaultBaseUrl: defaultAiProviderBaseUrl("gemini") ?? "",
		apiModes: ["google_generate_content"],
		defaultApiMode: defaultAiProviderApiMode("gemini") ?? "google_generate_content",
		defaultRuntimeEnv: defaultAiProviderRuntimeEnvName("gemini") ?? "",
		modelPlaceholder: defaultAiProviderModels("gemini")[0]?.id ?? "",
		defaultModels: toProviderCatalogModels(defaultAiProviderModels("gemini")),
		apiKeyUrl: "https://aistudio.google.com/apikey",
	},
	mistral: {
		id: "mistral",
		label: "Mistral AI",
		defaultBaseUrl: defaultAiProviderBaseUrl("mistral") ?? "",
		apiModes: ["openai_chat"],
		defaultApiMode: defaultAiProviderApiMode("mistral") ?? "openai_chat",
		defaultRuntimeEnv: defaultAiProviderRuntimeEnvName("mistral") ?? "",
		modelPlaceholder: defaultAiProviderModels("mistral")[0]?.id ?? "",
		defaultModels: toProviderCatalogModels(defaultAiProviderModels("mistral")),
		apiKeyUrl: "https://console.mistral.ai/api-keys",
	},
	custom_openai_compatible: {
		id: "custom_openai_compatible",
		label: "Custom (OpenAI-compatible)",
		defaultBaseUrl: "",
		apiModes: ["openai_chat", "openai_responses"],
		defaultApiMode: "openai_chat",
		defaultRuntimeEnv: CUSTOM_OPENAI_COMPATIBLE_RUNTIME_ENV,
		modelPlaceholder: CUSTOM_OPENAI_COMPATIBLE_MODEL_PLACEHOLDER,
		defaultModels: [],
		custom: true,
	},
};

export const API_MODE_LABEL: Record<ApiMode, string> = {
	openai_chat: "OpenAI Chat Completions",
	openai_responses: "OpenAI Responses",
	anthropic_messages: "Anthropic Messages",
	google_generate_content: "Gemini generateContent",
};

export function providerTypeMeta(id: string): ProviderTypeMeta {
	return PROVIDER_TYPE_META[id as ProviderTypeId] ?? PROVIDER_TYPE_META.custom_openai_compatible;
}

export function toProviderCatalogModels(
	models: readonly CatalogAiProviderModel[],
): ProviderCatalogModel[] {
	return models.map((model) => ({
		id: model.id,
		...(model.label ? { label: model.label } : {}),
		...(model.alias ? { alias: model.alias } : {}),
		...(model.api_mode ? { api_mode: model.api_mode } : {}),
		...(model.input_modalities ? { input_modalities: [...model.input_modalities] } : {}),
		...(model.supports_vision !== undefined ? { supports_vision: model.supports_vision } : {}),
		...(model.supports_tools !== undefined ? { supports_tools: model.supports_tools } : {}),
		...(model.supports_reasoning !== undefined
			? { supports_reasoning: model.supports_reasoning }
			: {}),
		...(model.context_window !== undefined ? { context_window: model.context_window } : {}),
		...(model.max_input_tokens !== undefined
			? { max_input_tokens: model.max_input_tokens }
			: {}),
		...(model.max_tokens !== undefined ? { max_tokens: model.max_tokens } : {}),
		...(model.compat && Object.keys(model.compat).length > 0
			? { compat: { ...model.compat } }
			: {}),
		...(model.cost ? { cost: { ...model.cost } } : {}),
		...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
	}));
}

/** Slugify a label into a valid provider_id (`^[a-z][a-z0-9._-]{1,62}$`). */
export function toProviderId(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 63);
	return slug.length >= 2 ? slug : "";
}
