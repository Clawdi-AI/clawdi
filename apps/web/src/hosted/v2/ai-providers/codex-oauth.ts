export { codexProviderBody } from "@clawdi/shared/api";

export const CLAWDI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";

/**
 * Compatibility-only relay for authorization-code flows started by the previous
 * Web release. Keep the route for at least the 10-minute backend state TTL after
 * the device-flow release is fully deployed; new connections never use it.
 */
export const CODEX_OAUTH_CALLBACK_COMPATIBILITY_TTL_SECONDS = 10 * 60;
export const CODEX_OAUTH_CHANNEL = "clawdi-codex-oauth";

export type CodexOAuthResult = {
	code: string;
	state: string;
	error?: string;
};

const CODEX_OAUTH_CALLBACK_SENSITIVE_PARAMS = [
	"code",
	"state",
	"provider_oauth",
	"error",
	"error_code",
	"error_description",
	"error_uri",
] as const;

export function sanitizeCodexCallbackHistoryUrl(input: string): string {
	const url = new URL(input);
	for (const key of CODEX_OAUTH_CALLBACK_SENSITIVE_PARAMS) url.searchParams.delete(key);
	const fragmentText = url.hash.replace(/^#/, "");
	if (fragmentText.includes("=") || fragmentText.includes("&")) {
		const fragment = new URLSearchParams(fragmentText);
		for (const key of CODEX_OAUTH_CALLBACK_SENSITIVE_PARAMS) fragment.delete(key);
		const nextFragment = fragment.toString();
		url.hash = nextFragment ? `#${nextFragment}` : "";
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

export function parseCodexCallback(input: string): CodexOAuthResult | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let search = "";
	let hash = "";
	try {
		const url = new URL(trimmed);
		search = url.search;
		hash = url.hash.replace(/^#/, "");
	} catch {
		search = trimmed.replace(/^[?#]/, "");
	}
	const query = new URLSearchParams(search);
	const fragment = new URLSearchParams(hash);
	const code = query.get("code") || fragment.get("code") || "";
	const state = query.get("state") || fragment.get("state") || "";
	const error = query.get("error") || fragment.get("error") || undefined;
	if (error) return { code: "", state: "", error };
	return code && state ? { code, state } : null;
}
