import type { AiProviderApiMode, AiProviderType } from "./ai-provider";
import routing from "./native-ai-providers.json";

// Verified against OpenClaw 71e3383a and Hermes a7198a88. This is auth/routing
// metadata only: catalogs and model selection belong to the native runtime.
export type NativeAiProvider = Omit<(typeof routing)[number], "type" | "api_mode"> & {
	type: AiProviderType;
	api_mode: AiProviderApiMode;
};

function checkedRouting(entry: (typeof routing)[number]): NativeAiProvider {
	const { type, api_mode } = entry;
	if (
		type !== "openai" &&
		type !== "anthropic" &&
		type !== "openrouter" &&
		type !== "gemini" &&
		type !== "mistral" &&
		type !== "custom_openai_compatible"
	) {
		throw new Error(`Invalid native provider type: ${type}`);
	}
	if (
		api_mode !== "openai_chat" &&
		api_mode !== "openai_responses" &&
		api_mode !== "anthropic_messages" &&
		api_mode !== "google_generate_content"
	) {
		throw new Error(`Invalid native provider API mode: ${api_mode}`);
	}
	return { ...entry, type, api_mode };
}

export const NATIVE_AI_PROVIDERS: readonly NativeAiProvider[] = routing.map(checkedRouting);

export function nativeAiProvider(
	identity: string | null | undefined,
	variant?: string | null,
): NativeAiProvider | undefined {
	return NATIVE_AI_PROVIDERS.find(
		(entry) => entry.id === identity && (variant == null || entry.variant === variant),
	);
}

export function nativeAiProviderForRuntime(
	runtime: "openclaw" | "hermes",
	identity: string,
	baseUrl: string,
	codexOAuth = false,
): NativeAiProvider | undefined {
	return NATIVE_AI_PROVIDERS.find(
		(entry) =>
			entry[runtime].provider === identity &&
			entry.base_url === baseUrl.replace(/\/+$/, "") &&
			(entry.id === "openai-codex") === codexOAuth,
	);
}
