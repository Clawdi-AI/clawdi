import { publicSessionId } from "@clawdi/shared/api";

export const accountOAuthReturnUrl = "clawdi://account-oauth";
type OAuthFlow = "account" | "sign-in" | "sign-up";
export const oauthReturnUrl = (flow: OAuthFlow) => `clawdi://${flow}-oauth`;

export function accountOAuthRedirect(
	attempt: string,
	flow: OAuthFlow = "account",
	publicShareId?: string | null,
): string {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attempt))
		throw new Error("Invalid OAuth attempt");
	const url = new URL(oauthReturnUrl(flow));
	url.searchParams.set("clawdi_attempt", attempt);
	if (publicShareId) {
		const share = publicSessionId(publicShareId);
		if (!share) throw new Error("Invalid public Session return");
		url.searchParams.set("publicShareId", share);
	}
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
		url.searchParams.getAll("publicShareId").length > 1 ||
		url.searchParams.get("publicShareId") !== target.searchParams.get("publicShareId") ||
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
	const match = /^(?:clawdi:\/\/\/?|\/?)(account|sign-in|sign-up)-oauth(?:[/?#]|$)/i.exec(path);
	if (match) {
		if (match[1]?.toLowerCase() === "account") return "/settings/account/connected-accounts";
		const destination = match[1]?.toLowerCase() === "sign-up" ? "/sign-up" : "/sign-in";
		try {
			const url = new URL(path, "clawdi:///");
			const share = publicSessionId(url.searchParams.get("publicShareId") ?? "");
			return share ? `${destination}?publicShareId=${encodeURIComponent(share)}` : destination;
		} catch {
			return destination;
		}
	}
	return path;
}
