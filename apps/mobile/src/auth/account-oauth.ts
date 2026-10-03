export const accountOAuthReturnUrl = "clawdi://account-oauth";

export function accountOAuthRedirect(attempt: string): string {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attempt))
		throw new Error("Invalid OAuth attempt");
	const url = new URL(accountOAuthReturnUrl);
	url.searchParams.set("clawdi_attempt", attempt);
	return url.href;
}

/** Browser completion alone is not proof of account authorization. */
export function accountOAuthNonce(callback: string, expected: string): string {
	if (callback.length > 8192) throw new Error("Invalid OAuth callback");
	const url = new URL(callback);
	const target = new URL(expected);
	if (
		url.protocol !== target.protocol ||
		url.host !== target.host ||
		url.pathname !== target.pathname ||
		url.username ||
		url.password ||
		url.hash ||
		url.searchParams.has("error") ||
		url.searchParams.getAll("clawdi_attempt").length !== 1 ||
		url.searchParams.get("clawdi_attempt") !== target.searchParams.get("clawdi_attempt") ||
		url.searchParams.getAll("rotating_token_nonce").length !== 1
	)
		throw new Error("OAuth callback mismatch");
	const nonce = url.searchParams.get("rotating_token_nonce");
	if (!nonce || nonce.length > 4096 || /\s/.test(nonce)) throw new Error("Invalid OAuth nonce");
	return nonce;
}

export function accountOAuthAuthorizationUrl(value: URL | null | undefined): string {
	if (value?.protocol !== "https:" || value.username || value.password || !value.hostname)
		throw new Error("Invalid authorization URL");
	return value.href;
}

/** Keep callback credentials out of Router parameters, including cold starts. */
export function accountOAuthNavigation(path: string): string {
	if (/^(?:clawdi:\/\/\/?|\/?)account-oauth(?:[/?#]|$)/i.test(path)) return "/connected-accounts";
	return path;
}
