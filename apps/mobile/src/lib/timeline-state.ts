import type {
	components,
	SessionMessagesQuery,
	SessionSearchAnchor,
	SessionTimelineView,
} from "@clawdi/shared/api";
import { sessionTimelineCategories } from "@clawdi/shared/api";

export type TimelinePage = components["schemas"]["SessionTimelinePage"];
export type TimelineCursor = {
	offset: number;
	limit: number;
	revision?: string;
	initial?: boolean;
};

/** include always requests the typed projection; legacy positionless content is not shareable. */
export function timelinePage(
	page: TimelinePage | components["schemas"]["SessionMessagesPage"],
): TimelinePage {
	const items: TimelinePage["items"] = [];
	for (const item of page.items) {
		if (
			!("kind" in item) ||
			!("position" in item) ||
			!Number.isSafeInteger(item.position) ||
			item.position < 0
		)
			throw new Error("Invalid timeline position");
		if (
			item.kind === "message" &&
			typeof item.content === "string" &&
			(item.role === "user" || item.role === "assistant")
		)
			items.push(item);
		else if (
			item.kind === "tool_call" &&
			typeof item.call_id === "string" &&
			typeof item.name === "string"
		)
			items.push(item);
		else if (
			item.kind === "tool_result" &&
			typeof item.call_id === "string" &&
			(item.status === "completed" || item.status === "error")
		)
			items.push(item);
		else throw new Error("Invalid timeline entry");
	}
	return { ...page, items };
}

export function adjacentTimelineCursor(
	page: TimelinePage,
	previous = false,
): TimelineCursor | undefined {
	if (!page.content_revision || !page.items.length) return;
	if (previous)
		return page.offset > 0
			? {
					offset: Math.max(0, page.offset - 50),
					limit: Math.min(50, page.offset),
					revision: page.content_revision,
				}
			: undefined;
	const offset = page.offset + page.items.length;
	return offset < page.total ? { offset, limit: 50, revision: page.content_revision } : undefined;
}

export function timelineRequest(
	cursor: TimelineCursor,
	view: SessionTimelineView,
	query?: string,
	anchor?: SessionSearchAnchor,
	direction: "asc" | "desc" = "asc",
): SessionMessagesQuery {
	return {
		offset: cursor.offset,
		limit: cursor.limit,
		direction,
		include: sessionTimelineCategories(view),
		content_revision: cursor.revision,
		...(cursor.initial
			? {
					search_query: query,
					anchor_kind: anchor?.kind,
					anchor_position: anchor?.position,
					anchor_revision: anchor?.revision,
				}
			: {}),
	};
}
