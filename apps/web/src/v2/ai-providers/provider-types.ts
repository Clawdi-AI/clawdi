/**
 * The six AI provider types (backend `ProviderType`) with the defaults the
 * add flow prefills: base URL, allowed API modes, runtime env var, and a
 * model placeholder. Tints reuse the app identity palette.
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

export type ApiMode =
	| "openai_chat"
	| "openai_responses"
	| "anthropic_messages"
	| "google_generate_content";

export interface ProviderTypeMeta {
	id: ProviderTypeId;
	label: string;
	tint: string;
	defaultBaseUrl: string;
	apiModes: ApiMode[];
	defaultApiMode: ApiMode;
	defaultRuntimeEnv: string;
	modelPlaceholder: string;
	/** base_url + api_mode are user-supplied / required. */
	custom?: boolean;
	/** Offers "Sign in with ChatGPT" (Codex OAuth). */
	oauth?: boolean;
}

export const PROVIDER_TYPE_META: Record<ProviderTypeId, ProviderTypeMeta> = {
	openai: {
		id: "openai",
		label: "OpenAI",
		tint: "bg-identity-2-bg text-identity-2-fg",
		defaultBaseUrl: "https://api.openai.com/v1",
		apiModes: ["openai_chat", "openai_responses"],
		defaultApiMode: "openai_chat",
		defaultRuntimeEnv: "OPENAI_API_KEY",
		modelPlaceholder: "gpt-4o",
		oauth: true,
	},
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		tint: "bg-identity-1-bg text-identity-1-fg",
		defaultBaseUrl: "https://api.anthropic.com",
		apiModes: ["anthropic_messages"],
		defaultApiMode: "anthropic_messages",
		defaultRuntimeEnv: "ANTHROPIC_API_KEY",
		modelPlaceholder: "claude-sonnet-4-5",
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter",
		tint: "bg-identity-7-bg text-identity-7-fg",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		apiModes: ["openai_chat"],
		defaultApiMode: "openai_chat",
		defaultRuntimeEnv: "OPENROUTER_API_KEY",
		modelPlaceholder: "anthropic/claude-3.7-sonnet",
	},
	gemini: {
		id: "gemini",
		label: "Gemini",
		tint: "bg-identity-3-bg text-identity-3-fg",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiModes: ["google_generate_content"],
		defaultApiMode: "google_generate_content",
		defaultRuntimeEnv: "GEMINI_API_KEY",
		modelPlaceholder: "gemini-2.0-flash",
	},
	mistral: {
		id: "mistral",
		label: "Mistral",
		tint: "bg-identity-4-bg text-identity-4-fg",
		defaultBaseUrl: "https://api.mistral.ai/v1",
		apiModes: ["openai_chat"],
		defaultApiMode: "openai_chat",
		defaultRuntimeEnv: "MISTRAL_API_KEY",
		modelPlaceholder: "mistral-large-latest",
	},
	custom_openai_compatible: {
		id: "custom_openai_compatible",
		label: "Custom (OpenAI-compatible)",
		tint: "bg-identity-6-bg text-identity-6-fg",
		defaultBaseUrl: "",
		apiModes: ["openai_chat", "openai_responses"],
		defaultApiMode: "openai_chat",
		defaultRuntimeEnv: "CUSTOM_API_KEY",
		modelPlaceholder: "model name",
		custom: true,
	},
};

export const API_MODE_LABEL: Record<ApiMode, string> = {
	openai_chat: "OpenAI Chat",
	openai_responses: "OpenAI Responses",
	anthropic_messages: "Anthropic Messages",
	google_generate_content: "Google GenerateContent",
};

export function providerTypeMeta(id: string): ProviderTypeMeta {
	return PROVIDER_TYPE_META[id as ProviderTypeId] ?? PROVIDER_TYPE_META.custom_openai_compatible;
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
