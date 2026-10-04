const AUTH_ORIGIN = "https://clawdi.invalid";

export function sanitizeAuthRedirectPath(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls that URL parsing would silently strip.
	if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value))
		return "/";
	try {
		const destination = new URL(value, AUTH_ORIGIN);
		return destination.origin === AUTH_ORIGIN
			? `${destination.pathname}${destination.search}${destination.hash}`
			: "/";
	} catch {
		return "/";
	}
}

export function signInActionHref(destination: string): string {
	return `/sign-in?redirect_url=${encodeURIComponent(sanitizeAuthRedirectPath(destination))}`;
}
