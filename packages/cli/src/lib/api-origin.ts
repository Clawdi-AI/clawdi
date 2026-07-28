const PRODUCTION_CLOUD_API_ORIGIN = "https://cloud-api.clawdi.ai";

type ParsedApiBaseUrl = {
	url: URL;
	rawPath: string;
};

function parseApiBaseUrl(raw: string, label: string): ParsedApiBaseUrl {
	if (typeof raw !== "string" || raw.length > 2_048) {
		throw new Error(`${label} must be a valid absolute http:// or https:// URL.`);
	}
	const trimmed = raw.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${label} must be a valid absolute http:// or https:// URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${label} must use http:// or https://.`);
	}
	const schemeEnd = trimmed.indexOf("://") + 3;
	const authorityEnd = trimmed.slice(schemeEnd).search(/[/?#]/);
	const authority =
		authorityEnd === -1
			? trimmed.slice(schemeEnd)
			: trimmed.slice(schemeEnd, schemeEnd + authorityEnd);
	if (url.username || url.password || authority.includes("@")) {
		throw new Error(`${label} must not contain credentials.`);
	}
	if (
		!url.hostname ||
		(!url.hostname.startsWith("[") &&
			!url.hostname
				.split(".")
				.every((labelPart) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(labelPart)))
	) {
		throw new Error(`${label} must contain a canonical hostname.`);
	}
	if (trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error(`${label} must not contain a query or fragment.`);
	}

	const pathStart = trimmed.indexOf("/", schemeEnd);
	const rawPath = pathStart === -1 ? "" : trimmed.slice(pathStart);
	return { url, rawPath };
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requireSecureTransport(url: URL, label: string): void {
	if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
		throw new Error(`${label} must use HTTPS except on loopback localhost.`);
	}
}

/**
 * Normalize the Cloud request base. Cloud has no compatible path-prefixed
 * spelling: authenticated routes are always rooted at the URL origin.
 */
export function normalizeCloudApiBaseUrl(raw: string): string {
	const label = "Clawdi Cloud API URL";
	const { url, rawPath } = parseApiBaseUrl(raw, label);
	requireSecureTransport(url, label);
	if ((rawPath !== "" && rawPath !== "/") || url.pathname !== "/") {
		throw new Error(`${label} must not contain a non-root path.`);
	}
	return url.origin;
}

/**
 * Preserve Hosted's established `/v2` base alias, then return the exact base
 * used to build generated-client requests. Other paths are not accepted.
 */
export function normalizeHostedDeployApiBaseUrl(raw: string): string {
	const label = "Hosted deploy API URL";
	const { url, rawPath } = parseApiBaseUrl(raw, label);
	requireSecureTransport(url, label);
	if (!["", "/", "/v2", "/v2/"].includes(rawPath)) {
		throw new Error(`${label} must use the origin root or the compatible /v2 base.`);
	}
	if (url.pathname !== "/" && url.pathname !== "/v2" && url.pathname !== "/v2/") {
		throw new Error(`${label} must use the origin root or the compatible /v2 base.`);
	}
	return url.origin;
}

/** Canonical URL origin: lower-case host, effective port, and no trailing slash. */
export function canonicalApiOrigin(normalizedBaseUrl: string): string {
	return new URL(normalizedBaseUrl).origin;
}

export function isProductionCloudApiOrigin(origin: string): boolean {
	return origin === PRODUCTION_CLOUD_API_ORIGIN;
}
