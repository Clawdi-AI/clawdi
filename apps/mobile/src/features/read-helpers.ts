import type { components } from "@clawdi/shared/api";

export function routeParam(value: string | string[] | undefined): string | undefined {
	const candidate = Array.isArray(value) ? value[0] : value;
	return candidate && candidate.length <= 256 && candidate.trim() === candidate
		? candidate
		: undefined;
}

export function nextSessionPage(page: components["schemas"]["Paginated_SessionListItemResponse_"]) {
	return page.items.length > 0 && page.page * page.page_size < page.total
		? page.page + 1
		: undefined;
}

export function nextMessageOffset(page: components["schemas"]["SessionMessagesPage"]) {
	const next = page.offset + page.items.length;
	return page.items.length > 0 && next < page.total && page.content_revision ? next : undefined;
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

export function messagePage(
	page: components["schemas"]["SessionMessagesPage"] | components["schemas"]["SessionTimelinePage"],
): Omit<components["schemas"]["SessionTimelinePage"], "items"> & {
	items: components["schemas"]["SessionTimelineMessageResponse"][];
} {
	const items: components["schemas"]["SessionTimelineMessageResponse"][] = [];
	for (const item of page.items) {
		if (
			!("kind" in item) ||
			item.kind !== "message" ||
			!("position" in item) ||
			!Number.isSafeInteger(item.position) ||
			item.position < 0 ||
			!("role" in item) ||
			!("content" in item) ||
			typeof item.content !== "string" ||
			(item.role !== "user" && item.role !== "assistant")
		) {
			throw new Error("Unexpected message projection");
		}
		items.push({
			kind: "message",
			position: item.position,
			role: item.role,
			content: item.content,
			timestamp: item.timestamp,
			model: item.model,
		});
	}
	return { ...page, items };
}
