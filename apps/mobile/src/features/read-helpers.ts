import type { components } from "@clawdi/shared/api";

export function routeParam(value: string | string[] | undefined): string | undefined {
	const candidate = Array.isArray(value) ? value[0] : value;
	return candidate && candidate.length <= 256 && candidate.trim() === candidate
		? candidate
		: undefined;
}

/** An invalid explicit Project filter must never become an unscoped request. */
export function projectRouteFilter(
	value: string | string[] | undefined,
): { kind: "all" } | { kind: "project"; id: string } | { kind: "invalid" } {
	if (value === undefined) return { kind: "all" };
	const id = typeof value === "string" ? routeParam(value) : undefined;
	return id ? { kind: "project", id } : { kind: "invalid" };
}

export function nextSessionPage(page: components["schemas"]["Paginated_SessionListItemResponse_"]) {
	return page.items.length > 0 && page.page * page.page_size < page.total
		? page.page + 1
		: undefined;
}

export function limitedText(value: string, limit = 12000) {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function uniqueSessions(
	pages: readonly components["schemas"]["Paginated_SessionListItemResponse_"][],
) {
	const seen = new Set<string>();
	return pages
		.flatMap((page) => page.items)
		.filter((item) => {
			if (seen.has(item.id)) return false;
			seen.add(item.id);
			return true;
		});
}
