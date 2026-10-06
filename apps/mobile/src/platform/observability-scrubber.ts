import type { Breadcrumb, Event } from "@sentry/react-native";

const privateKeys =
	/^(?:body|request_body|query_string|query|search|hash|headers|cookies|user|token|.*_token|.*Token|authorization|password|secret|clawdi_attempt)$/;

function scrubText(value: string): string {
	return value.replace(/(?:https?:\/\/|clawdi:\/\/|\/)[^\s"'<>]+/g, (url) =>
		(url.split(/[?#]/, 1)[0] ?? "")
			.replace(/\/\/[^/@\s]+@/, "//")
			.replace(/(\/share\/)[^/\s]+/, "$1[Filtered]"),
	);
}

function hasVaultRequest(value: unknown): boolean {
	if (typeof value === "string") return /(?:^|\/)vault-request(?:[/?#\s]|$)/.test(value);
	if (Array.isArray(value)) return value.some(hasVaultRequest);
	if (value && typeof value === "object") return Object.values(value).some(hasVaultRequest);
	return false;
}

function scrubValue(value: unknown, request = false): unknown {
	if (typeof value === "string") return scrubText(value);
	if (Array.isArray(value)) return value.map((item) => scrubValue(item, request));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !(request && key === "data") && !privateKeys.test(key))
			.map(([key, item]) => [key, scrubValue(item, key === "request")]),
	);
}

export function scrubMobileBreadcrumb(breadcrumb: Breadcrumb, pathname: string): Breadcrumb | null {
	if (hasVaultRequest(pathname) || hasVaultRequest(breadcrumb)) return null;
	// Breadcrumb.data holds useful HTTP/navigation metadata; scrub its contents separately.
	const { data, ...rest } = breadcrumb;
	return {
		...rest,
		...(rest.message ? { message: scrubText(rest.message) } : {}),
		...(data ? { data: scrubValue(data) as Record<string, unknown> } : {}),
	};
}

export function scrubMobileEvent<T extends Event>(event: T, pathname: string): T | null {
	if (hasVaultRequest(pathname) || hasVaultRequest(event)) return null;
	// Preserve diagnostic metadata while removing bodies only from request payloads.
	return {
		...(scrubValue(event) as T),
		breadcrumbs: event.breadcrumbs?.flatMap((breadcrumb) => {
			const scrubbed = scrubMobileBreadcrumb(breadcrumb, pathname);
			return scrubbed ? [scrubbed] : [];
		}),
	};
}
