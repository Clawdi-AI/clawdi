function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

function isSchemeRelative(target: string): boolean {
	return /^(?:[/\\]{2}|[/\\][\\/])/.test(target);
}

function isRelativeReference(target: string): boolean {
	return !/^[a-z][a-z\d+.-]*:/i.test(target);
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

/**
 * Defense-in-depth for API-provided document navigation targets. Production
 * destinations must use HTTPS; loopback HTTP remains available for local
 * development. Relative references remain relative without a browser base so
 * SSR/static anchors keep the browser's same-origin resolution semantics.
 */
export function safeExternalNavigationUrl(
	target: string | null | undefined,
	baseUrl?: string,
): string | null {
	if (!target || hasControlCharacter(target) || target.includes("\\")) return null;
	const trimmed = target?.trim();
	if (!trimmed) return null;
	const relative = isRelativeReference(trimmed);
	if (isSchemeRelative(trimmed)) return null;
	if (!relative && !/^https?:\/\/[^/\\]/i.test(trimmed)) return null;
	if (!baseUrl && relative) return trimmed;
	try {
		const url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
		if (relative && baseUrl) {
			const base = new URL(baseUrl);
			return url.origin === base.origin ? url.href : null;
		}
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && isLoopbackHostname(url.hostname))
		) {
			return null;
		}
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
