// Defense in depth only. Secret-bearing queries and actions must avoid or
// remove secrets structurally before TanStack owns the value. Adding a field
// name here is not the fix for a new secret-bearing flow.
const SENSITIVE_CACHE_FIELDS = new Set([
	"access_token",
	"agent_token",
	"api_key",
	"auth_cert",
	"auth_url",
	"checkout_url",
	"client_secret",
	"connect_url",
	"credential",
	"credentials",
	"creds",
	"mcp_token",
	"mem0_api_key",
	"password",
	"payment_intent_client_secret",
	"portal_url",
	"private_key",
	"provider_token",
	"raw_key",
	"raw_token",
	"refresh_token",
	"secret",
	"token",
	"websocket_url",
]);

function isPlainRecord(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Remove plaintext secret fields before a response becomes QueryCache data. */
export function sanitizeQueryCacheValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const sanitized = sanitizeQueryCacheValue(item);
			if (sanitized !== item) changed = true;
			return sanitized;
		});
		return changed ? next : value;
	}
	if (typeof value !== "object" || value === null || !isPlainRecord(value)) return value;

	let changed = false;
	const entries: Array<[string, unknown]> = [];
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_CACHE_FIELDS.has(key.toLowerCase())) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeQueryCacheValue(item);
		if (sanitized !== item) changed = true;
		entries.push([key, sanitized]);
	}
	return changed ? Object.fromEntries(entries) : value;
}

export function cacheValueContains(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (Array.isArray(value)) return value.some((item) => cacheValueContains(item, needle));
	if (typeof value !== "object" || value === null) return false;
	return Object.entries(value).some(
		([key, item]) => key.includes(needle) || cacheValueContains(item, needle),
	);
}
