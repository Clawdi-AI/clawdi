import type { SessionListItem } from "@clawdi/shared/api";
import { SEARCH_QUERY_MAX_LENGTH, searchQueryLength } from "@clawdi/shared/consts";

export type SessionSearchAnchor = NonNullable<SessionListItem["search_match"]>["anchor"];
export const SESSION_TIMELINE_CATEGORIES = ["user", "assistant", "tools"] as const;
export type SessionTimelineCategory = (typeof SESSION_TIMELINE_CATEGORIES)[number];
type SessionTimelineFilteredView =
	| SessionTimelineCategory
	| "user,assistant"
	| "user,tools"
	| "assistant,tools";
export type SessionTimelineView = "all" | SessionTimelineFilteredView;

export interface SessionDetailSearch {
	matchKind?: SessionSearchAnchor["kind"];
	matchPosition?: number;
	matchRevision?: string;
	matchQuery?: string;
	timelineView?: SessionTimelineFilteredView;
	returnTo?: string;
}

interface SessionDetailLink {
	to: "/sessions/$id";
	params: { id: string };
	search: SessionDetailSearch & Record<string, unknown>;
}

function validPosition(value: unknown): number | undefined {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseSessionTimelineView(value: unknown): SessionTimelineFilteredView | undefined {
	if (typeof value !== "string") return undefined;
	const values = value.split(",");
	if (
		values.length === 0 ||
		values.some(
			(category) => !SESSION_TIMELINE_CATEGORIES.includes(category as SessionTimelineCategory),
		)
	) {
		return undefined;
	}
	const view = sessionTimelineViewFromCategories(values);
	return view === "all" || view === null ? undefined : view;
}

export function sessionTimelineCategories(view: SessionTimelineView): SessionTimelineCategory[] {
	return view === "all"
		? [...SESSION_TIMELINE_CATEGORIES]
		: (view.split(",") as SessionTimelineCategory[]);
}

export function sessionTimelineViewFromCategories(
	values: readonly string[],
): SessionTimelineView | null {
	const selected = new Set(
		values.filter((value): value is SessionTimelineCategory =>
			SESSION_TIMELINE_CATEGORIES.includes(value as SessionTimelineCategory),
		),
	);
	if (selected.size === 0) return null;
	if (selected.size === SESSION_TIMELINE_CATEGORIES.length) return "all";
	return SESSION_TIMELINE_CATEGORIES.filter((category) => selected.has(category)).join(
		",",
	) as SessionTimelineFilteredView;
}

export function sessionTimelineIncludesMessages(view: SessionTimelineView): boolean {
	return sessionTimelineCategories(view).some((category) => category !== "tools");
}

export function validateSessionDetailSearch(search: Record<string, unknown>): SessionDetailSearch {
	const returnTo = normalizeSessionListReturnTo(search.returnTo);
	const timelineView = parseSessionTimelineView(search.timelineView);
	const matchQuery =
		timelineView && !sessionTimelineIncludesMessages(timelineView)
			? undefined
			: normalizeSessionMatchQuery(search.matchQuery);
	const standalone = {
		...(matchQuery ? { matchQuery } : {}),
		...(timelineView ? { timelineView } : {}),
		...(returnTo ? { returnTo } : {}),
	};
	if (timelineView && !sessionTimelineIncludesMessages(timelineView)) return standalone;
	const kind =
		search.matchKind === "snapshot_offset" || search.matchKind === "event_seq"
			? search.matchKind
			: undefined;
	const position = validPosition(search.matchPosition);
	const revision =
		typeof search.matchRevision === "string" &&
		search.matchRevision.length > 0 &&
		search.matchRevision.length <= 80
			? search.matchRevision
			: undefined;
	if (!kind || position === undefined || !revision) return standalone;
	return {
		matchKind: kind,
		matchPosition: position,
		matchRevision: revision,
		...(matchQuery ? { matchQuery } : {}),
		...(timelineView ? { timelineView } : {}),
		...(returnTo ? { returnTo } : {}),
	};
}

export function sessionTimelineViewLink(
	sessionId: string,
	view: SessionTimelineView,
	options: { returnTo?: string; searchQuery?: string } = {},
): SessionDetailLink {
	const returnTo = normalizeSessionListReturnTo(options.returnTo);
	const matchQuery = sessionTimelineIncludesMessages(view)
		? normalizeSessionMatchQuery(options.searchQuery)
		: undefined;
	return {
		to: "/sessions/$id" as const,
		params: { id: sessionId },
		search: {
			...(matchQuery ? { matchQuery } : {}),
			...(view === "all" ? {} : { timelineView: view }),
			...(returnTo ? { returnTo } : {}),
		},
	};
}

export function sessionDetailSearchLink(
	sessionId: string,
	query: string,
	options: { returnTo?: string; timelineView?: SessionTimelineView } = {},
): SessionDetailLink {
	const returnTo = normalizeSessionListReturnTo(options.returnTo);
	const timelineView =
		options.timelineView === "all" ? undefined : parseSessionTimelineView(options.timelineView);
	const matchQuery =
		!timelineView || sessionTimelineIncludesMessages(timelineView)
			? normalizeSessionMatchQuery(query)
			: undefined;
	return {
		to: "/sessions/$id" as const,
		params: { id: sessionId },
		search: {
			...(matchQuery ? { matchQuery } : {}),
			...(timelineView ? { timelineView } : {}),
			...(returnTo ? { returnTo } : {}),
		},
	};
}

function normalizeSessionMatchQuery(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized && searchQueryLength(normalized) <= SEARCH_QUERY_MAX_LENGTH
		? normalized
		: undefined;
}

export function normalizeSessionListReturnTo(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
	try {
		const base = new URL("https://clawdi.invalid");
		const parsed = new URL(value, base);
		if (parsed.origin !== base.origin || parsed.pathname !== "/sessions" || parsed.hash) {
			return undefined;
		}
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return undefined;
	}
}

export function sessionSearchAnchorFromSearch(
	search: SessionDetailSearch,
): SessionSearchAnchor | undefined {
	if (!search.matchKind || search.matchPosition === undefined || !search.matchRevision) {
		return undefined;
	}
	return {
		kind: search.matchKind,
		position: search.matchPosition,
		revision: search.matchRevision,
	};
}

export function sessionDetailLink(
	session: Pick<SessionListItem, "id" | "search_match">,
	options: { returnTo?: string; searchQuery?: string } = {},
): SessionDetailLink {
	const anchor = session.search_match?.anchor;
	if (anchor) {
		return sessionSearchMatchLink(session.id, anchor, options);
	}
	const returnTo = normalizeSessionListReturnTo(options.returnTo);
	return {
		to: "/sessions/$id" as const,
		params: { id: session.id },
		search: {
			...(returnTo ? { returnTo } : {}),
		},
	};
}

export function sessionSearchMatchLink(
	sessionId: string,
	anchor: SessionSearchAnchor,
	options: {
		returnTo?: string;
		searchQuery?: string;
		timelineView?: SessionTimelineView;
	} = {},
): SessionDetailLink {
	const returnTo = normalizeSessionListReturnTo(options.returnTo);
	const timelineView =
		options.timelineView === "all" ? undefined : parseSessionTimelineView(options.timelineView);
	if (timelineView && !sessionTimelineIncludesMessages(timelineView)) {
		return sessionTimelineViewLink(sessionId, timelineView, { returnTo });
	}
	const matchQuery = normalizeSessionMatchQuery(options.searchQuery);
	return {
		to: "/sessions/$id" as const,
		params: { id: sessionId },
		search: {
			matchKind: anchor.kind,
			matchPosition: anchor.position,
			matchRevision: anchor.revision,
			...(matchQuery ? { matchQuery } : {}),
			...(timelineView ? { timelineView } : {}),
			...(returnTo ? { returnTo } : {}),
		},
	};
}
