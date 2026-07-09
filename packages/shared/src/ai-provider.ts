export const AI_PROVIDER_TYPES = [
	"openai",
	"anthropic",
	"openrouter",
	"gemini",
	"mistral",
	"custom_openai_compatible",
] as const;

export type AiProviderType = (typeof AI_PROVIDER_TYPES)[number];

export const AI_PROVIDER_API_MODES = [
	"openai_chat",
	"openai_responses",
	"anthropic_messages",
	"google_generate_content",
] as const;

export type AiProviderApiMode = (typeof AI_PROVIDER_API_MODES)[number];

export type AiProviderAuth =
	| { type: "secret_ref"; ref: string }
	| {
			type: "api_key";
			source: "env" | "vault" | "managed";
			ref?: string;
	  }
	| { type: "oauth_profile"; provider: string; profile: string }
	| { type: "agent_profile"; tool: string; profile: string }
	| { type: "none" };

export interface AiProviderCapabilities {
	chat?: boolean;
	responses?: boolean;
	tools?: boolean;
	vision?: boolean;
	embeddings?: boolean;
	image_generation?: boolean;
}

export interface AiProviderModelCost {
	input_per_million?: number;
	output_per_million?: number;
	cache_read_per_million?: number;
	cache_write_per_million?: number;
}

export interface AiProviderModel {
	id: string;
	label?: string;
	api_mode?: AiProviderApiMode;
	input_modalities?: Array<"text" | "image" | "video" | "audio">;
	supports_vision?: boolean;
	supports_tools?: boolean;
	supports_reasoning?: boolean;
	context_window?: number;
	max_tokens?: number;
	cost?: AiProviderModelCost;
	capabilities?: AiProviderCapabilities;
}

export interface AiProvider {
	id: string;
	type: AiProviderType;
	label?: string;
	base_url: string;
	api_mode?: AiProviderApiMode;
	auth: AiProviderAuth;
	managed_by?: "user" | "clawdi";
	runtime_env_name?: string;
	capabilities?: AiProviderCapabilities;
	models?: AiProviderModel[];
}

export interface AiProviderCatalog {
	schema_version: number;
	providers: AiProvider[];
	defaults?: {
		chat_provider_id?: string;
		embedding_provider_id?: string;
	};
}

export interface AiProviderValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface AiProviderValidationOptions {
	allowNoAuthPublic?: boolean;
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{1,62}$/;
const PROFILE_ID_RE = /^[a-z][a-z0-9._-]{0,119}$/;
const ENV_REF_RE = /^env:[A-Z][A-Z0-9_]{0,127}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

const COMPATIBLE_API_MODES: Record<AiProviderType, readonly AiProviderApiMode[]> = {
	openai: ["openai_chat", "openai_responses"],
	anthropic: ["anthropic_messages"],
	openrouter: ["openai_chat"],
	gemini: ["google_generate_content"],
	mistral: ["openai_chat"],
	custom_openai_compatible: ["openai_chat", "openai_responses"],
};

const DEFAULT_API_MODE: Partial<Record<AiProviderType, AiProviderApiMode>> = {
	openai: "openai_responses",
	anthropic: "anthropic_messages",
	openrouter: "openai_chat",
	gemini: "google_generate_content",
	mistral: "openai_chat",
};

const DEFAULT_BASE_URL: Partial<Record<AiProviderType, string>> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com",
	openrouter: "https://openrouter.ai/api/v1",
	gemini: "https://generativelanguage.googleapis.com/v1beta",
	mistral: "https://api.mistral.ai/v1",
};

const DEFAULT_RUNTIME_ENV_NAME: Partial<Record<AiProviderType, string>> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	gemini: "GEMINI_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

const DEFAULT_MODEL_CATALOG: Partial<Record<AiProviderType, readonly AiProviderModel[]>> = {
	openai: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }, { id: "gpt-5.4-mini" }],
	anthropic: [{ id: "claude-sonnet-5" }, { id: "claude-opus-4-6" }, { id: "claude-haiku-4-5" }],
	openrouter: [
		{ id: "anthropic/claude-sonnet-5" },
		{ id: "anthropic/claude-opus-4.6" },
		{ id: "openai/gpt-5.5" },
	],
	gemini: [{ id: "gemini-2.5-pro" }, { id: "gemini-3.5-flash" }],
	mistral: [{ id: "mistral-large-latest" }],
};

export const CODEX_OAUTH_MODEL_CATALOG: readonly AiProviderModel[] = [
	{ id: "gpt-5.5" },
	{ id: "gpt-5.4" },
	{ id: "gpt-5.3-codex" },
	{ id: "gpt-5.4-mini" },
];

export const CLAWDI_MANAGED_V1_PROVIDER_ID = "clawdi-managed";
const CLAWDI_MANAGED_V1_API_MODE = "openai_responses";
export const CLAWDI_MANAGED_V2_PROVIDER_ID = "clawdi-managed-v2";
const CLAWDI_MANAGED_V2_API_MODE = "openai_chat";
export const CLAWDI_MANAGED_PROVIDER_IDS: ReadonlySet<string> = new Set([
	CLAWDI_MANAGED_V1_PROVIDER_ID,
	CLAWDI_MANAGED_V2_PROVIDER_ID,
]);
const CLAWDI_MANAGED_RUNTIME_ENV = "CLAWDI_MANAGED_OPENAI_API_KEY";
const CLAWDI_MANAGED_PLACEHOLDER_RUNTIME_ENV = "OPENAI_API_KEY";
const CLAWDI_MANAGED_RUNTIME_ENVS: ReadonlySet<string> = new Set([
	CLAWDI_MANAGED_RUNTIME_ENV,
	CLAWDI_MANAGED_PLACEHOLDER_RUNTIME_ENV,
]);

export interface AiProviderManagedIdentity {
	id?: string | null;
	provider_id?: string | null;
	managed_by?: string | null;
}

export function isFirstPartyManagedAiProvider(provider: AiProviderManagedIdentity): boolean {
	const id = provider.provider_id ?? provider.id;
	return (
		provider.managed_by === "clawdi" ||
		(typeof id === "string" && CLAWDI_MANAGED_PROVIDER_IDS.has(id))
	);
}

export function isAiProviderId(input: string): boolean {
	return PROVIDER_ID_RE.test(input);
}

export function isProviderAuthProfileId(input: string): boolean {
	return PROFILE_ID_RE.test(input);
}

export function isRuntimeEnvName(input: string): boolean {
	return ENV_NAME_RE.test(input);
}

export function isEnvSecretRef(input: unknown): boolean {
	return typeof input === "string" && ENV_REF_RE.test(input);
}

export function isClawdiSecretRef(input: unknown): boolean {
	return typeof input === "string" && input.startsWith("clawdi://");
}

export function isSupportedSecretRef(input: unknown): boolean {
	return isEnvSecretRef(input) || isClawdiSecretRef(input);
}

export function isAiProviderType(input: string): input is AiProviderType {
	return (AI_PROVIDER_TYPES as readonly string[]).includes(input);
}

export function isAiProviderApiMode(input: string): input is AiProviderApiMode {
	return (AI_PROVIDER_API_MODES as readonly string[]).includes(input);
}

export function defaultAiProviderApiMode(type: AiProviderType): AiProviderApiMode | undefined {
	return DEFAULT_API_MODE[type];
}

export function defaultAiProviderBaseUrl(type: AiProviderType): string | undefined {
	return DEFAULT_BASE_URL[type];
}

export function defaultAiProviderRuntimeEnvName(type: AiProviderType): string | undefined {
	return DEFAULT_RUNTIME_ENV_NAME[type];
}

export function defaultAiProviderModels(type: AiProviderType): readonly AiProviderModel[] {
	return DEFAULT_MODEL_CATALOG[type] ?? [];
}

export function validateAiProviderCatalog(
	catalog: AiProviderCatalog,
	options: AiProviderValidationOptions = {},
): AiProviderValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (catalog.schema_version !== 1) {
		errors.push("schema_version must be 1.");
	}
	if (!Array.isArray(catalog.providers)) {
		errors.push("providers must be an array.");
		return { valid: false, errors, warnings };
	}

	const ids = new Set<string>();
	for (const entry of catalog.providers) {
		if (!isRecord(entry)) {
			errors.push("Provider entry must be an object.");
			continue;
		}
		const provider = entry as AiProvider;
		validateProvider(provider, errors, warnings, options);
		if (typeof provider.id === "string" && ids.has(provider.id)) {
			errors.push(`Duplicate provider id: ${provider.id}`);
		}
		if (typeof provider.id === "string") {
			ids.add(provider.id);
		}
	}

	const defaults = catalog.defaults;
	if (defaults?.chat_provider_id && !ids.has(defaults.chat_provider_id)) {
		errors.push(
			`defaults.chat_provider_id references missing provider: ${defaults.chat_provider_id}`,
		);
	}
	if (defaults?.embedding_provider_id && !ids.has(defaults.embedding_provider_id)) {
		errors.push(
			`defaults.embedding_provider_id references missing provider: ${defaults.embedding_provider_id}`,
		);
	}

	return { valid: errors.length === 0, errors, warnings };
}

function validateProvider(
	provider: AiProvider,
	errors: string[],
	warnings: string[],
	options: AiProviderValidationOptions,
): void {
	const prefix = provider.id || "<missing>";
	if (!isAiProviderId(provider.id)) {
		errors.push(`Invalid provider id "${provider.id}".`);
	}
	if (!isAiProviderType(provider.type)) {
		errors.push(`Provider ${prefix} has invalid type "${provider.type}".`);
		return;
	}
	if (!isHttpUrl(provider.base_url)) {
		errors.push(`Provider ${prefix} has invalid base_url.`);
	}
	if (provider.api_mode !== undefined) {
		if (!isAiProviderApiMode(provider.api_mode)) {
			errors.push(`Provider ${prefix} has invalid api_mode "${provider.api_mode}".`);
		} else if (!COMPATIBLE_API_MODES[provider.type].includes(provider.api_mode)) {
			errors.push(
				`Provider ${prefix} type ${provider.type} is incompatible with api_mode ${provider.api_mode}.`,
			);
		}
	} else if (provider.type === "custom_openai_compatible") {
		errors.push(`Provider ${prefix} requires api_mode for custom_openai_compatible.`);
	}
	if (provider.runtime_env_name && !isRuntimeEnvName(provider.runtime_env_name)) {
		errors.push(`Provider ${prefix} has invalid runtime_env_name.`);
	}
	validateManagedProviderContract(prefix, provider, errors);
	const auth = (provider as { auth?: unknown }).auth;
	if (!isRecord(auth)) {
		errors.push(`Provider ${prefix} auth must be an object.`);
	} else {
		validateAuth(prefix, provider, auth as AiProviderAuth, errors, warnings, options);
	}
	validateModels(prefix, (provider as { models?: unknown }).models, errors);
}

function validateManagedProviderContract(
	prefix: string,
	provider: AiProvider,
	errors: string[],
): void {
	const isManagedContract =
		CLAWDI_MANAGED_PROVIDER_IDS.has(provider.id) || provider.managed_by === "clawdi";
	if (!isManagedContract) return;

	const expectedApiMode = clawdiManagedApiMode(provider.id);
	if (!expectedApiMode) {
		errors.push(
			`Provider ${prefix} managed_by clawdi must use id ${Array.from(CLAWDI_MANAGED_PROVIDER_IDS)
				.sort()
				.join(" or ")}.`,
		);
	}
	if (provider.managed_by !== "clawdi") {
		errors.push(`Provider ${prefix} with Clawdi-managed id must be managed_by clawdi.`);
	}
	if (provider.type !== "custom_openai_compatible") {
		errors.push(`Provider ${prefix} managed_by clawdi must use custom_openai_compatible.`);
	}
	if (expectedApiMode && provider.api_mode !== expectedApiMode) {
		errors.push(`Provider ${prefix} managed_by clawdi must use api_mode ${expectedApiMode}.`);
	}
	if (!provider.runtime_env_name || !CLAWDI_MANAGED_RUNTIME_ENVS.has(provider.runtime_env_name)) {
		errors.push(
			`Provider ${prefix} managed_by clawdi must use runtime_env_name ${Array.from(
				CLAWDI_MANAGED_RUNTIME_ENVS,
			).join(" or ")}.`,
		);
	}
	const auth = (provider as { auth?: unknown }).auth;
	if (!isRecord(auth) || auth.type !== "api_key" || auth.source !== "managed") {
		errors.push(`Provider ${prefix} managed_by clawdi must use managed api_key auth.`);
	}
}

function clawdiManagedApiMode(providerId: string): AiProviderApiMode | null {
	if (providerId === CLAWDI_MANAGED_V1_PROVIDER_ID) return CLAWDI_MANAGED_V1_API_MODE;
	if (providerId === CLAWDI_MANAGED_V2_PROVIDER_ID) return CLAWDI_MANAGED_V2_API_MODE;
	return null;
}

function validateAuth(
	prefix: string,
	provider: AiProvider,
	auth: AiProviderAuth,
	errors: string[],
	warnings: string[],
	options: AiProviderValidationOptions,
): void {
	if (auth.type === "secret_ref") {
		if (!isSupportedSecretRef(auth.ref)) {
			errors.push(`Provider ${prefix} has unsupported secret ref.`);
		}
		return;
	}
	if (auth.type === "api_key") {
		if (auth.source === "env" && (!auth.ref || !isEnvSecretRef(auth.ref))) {
			errors.push(`Provider ${prefix} api_key auth with source env requires env:<NAME> ref.`);
		}
		if (auth.source === "vault" && (!auth.ref || !isClawdiSecretRef(auth.ref))) {
			errors.push(`Provider ${prefix} api_key auth with source vault requires clawdi:// ref.`);
		}
		if (auth.source === "managed" && auth.ref) {
			errors.push(`Provider ${prefix} api_key auth with source managed must not include ref.`);
		}
		return;
	}
	if (auth.type === "oauth_profile") {
		if (!isProviderAuthProfileId(auth.provider) || !isProviderAuthProfileId(auth.profile)) {
			errors.push(`Provider ${prefix} has invalid oauth_profile auth metadata.`);
		}
		return;
	}
	if (auth.type === "agent_profile") {
		if (!isProviderAuthProfileId(auth.tool) || !isProviderAuthProfileId(auth.profile)) {
			errors.push(`Provider ${prefix} has invalid agent_profile auth metadata.`);
		}
		return;
	}
	if (auth.type === "none") {
		validateNoAuthUrl(prefix, provider.base_url, errors, warnings, options);
		return;
	}
	errors.push(`Provider ${prefix} has unsupported auth type.`);
}

function validateNoAuthUrl(
	prefix: string,
	baseUrl: string,
	errors: string[],
	warnings: string[],
	options: AiProviderValidationOptions,
): void {
	let hostname = "";
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return;
	}
	if (isLoopbackHost(hostname)) return;
	if (isPrivateHost(hostname)) {
		warnings.push(`Provider ${prefix} uses no auth on a private-network host.`);
		return;
	}
	if (!options.allowNoAuthPublic) {
		errors.push(`Provider ${prefix} uses no auth on a public URL.`);
	}
}

function validateModels(prefix: string, models: unknown, errors: string[]): void {
	if (!models) return;
	if (!Array.isArray(models)) {
		errors.push(`Provider ${prefix} models must be an array.`);
		return;
	}
	const ids = new Set<string>();
	for (const model of models) {
		if (!isRecord(model)) {
			errors.push(`Provider ${prefix} has invalid model metadata.`);
			continue;
		}
		const id = typeof model.id === "string" ? model.id : "";
		if (!id || ids.has(id)) {
			errors.push(`Provider ${prefix} has invalid or duplicate model id.`);
		}
		if (isLegacyOpenAiCodexModelRef(id)) {
			errors.push(
				`Provider ${prefix} model ${id || "<missing>"} must use the OpenAI model id without the legacy openai-codex prefix.`,
			);
		}
		ids.add(id);
		if (
			model.context_window !== undefined &&
			(typeof model.context_window !== "number" || model.context_window < 0)
		) {
			errors.push(`Provider ${prefix} model ${id || "<missing>"} has invalid context_window.`);
		}
		if (
			model.max_tokens !== undefined &&
			(typeof model.max_tokens !== "number" || model.max_tokens < 0)
		) {
			errors.push(`Provider ${prefix} model ${id || "<missing>"} has invalid max_tokens.`);
		}
		if (
			model.api_mode !== undefined &&
			(typeof model.api_mode !== "string" || !isAiProviderApiMode(model.api_mode))
		) {
			errors.push(`Provider ${prefix} model ${id || "<missing>"} has invalid api_mode.`);
		}
		for (const field of ["supports_vision", "supports_tools", "supports_reasoning"] as const) {
			if (model[field] !== undefined && typeof model[field] !== "boolean") {
				errors.push(`Provider ${prefix} model ${id || "<missing>"} has invalid ${field}.`);
			}
		}
	}
}

function isLegacyOpenAiCodexModelRef(input: unknown): boolean {
	return typeof input === "string" && input.startsWith("openai-codex/");
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isHttpUrl(input: string): boolean {
	try {
		const url = new URL(input);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		hostname === "0.0.0.0"
	);
}

function isPrivateHost(hostname: string): boolean {
	if (hostname.startsWith("10.")) return true;
	if (hostname.startsWith("192.168.")) return true;
	const match = /^172\.(\d+)\./.exec(hostname);
	if (!match) return false;
	const octet = Number(match[1]);
	return octet >= 16 && octet <= 31;
}
