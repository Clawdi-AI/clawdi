/**
 * Defense-in-depth for API-provided document navigation targets. Billing,
 * connector, and OAuth services may choose any HTTP(S) host, but they may not
 * inject executable or local-browser schemes.
 */
export function safeExternalNavigationUrl(
	target: string | null | undefined,
	baseUrl?: string,
): string | null {
	const trimmed = target?.trim();
	if (!trimmed) return null;
	try {
		const url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username || url.password) return null;
		return url.href;
	} catch {
		return null;
	}
}

export function safeBrowserNavigationUrl(target: string | null | undefined): string | null {
	if (typeof window === "undefined") return null;
	return safeExternalNavigationUrl(target, window.location.href);
}
