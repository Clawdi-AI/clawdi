import type { SessionListItem } from "@clawdi/shared/api";

export type SessionSearchAnchor = NonNullable<SessionListItem["search_match"]>["anchor"];
export type SessionTimelineView = "all" | "user" | "assistant" | "tools";

export interface SessionDetailSearch {
	matchKind?: SessionSearchAnchor["kind"];
	matchPosition?: number;
	matchRevision?: string;
	matchQuery?: string;
	timelineView?: Exclude<SessionTimelineView, "all">;
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

export function parseSessionTimelineView(
	value: unknown,
): Exclude<SessionTimelineView, "all"> | undefined {
	return value === "user" || value === "assistant" || value === "tools" ? value : undefined;
}

export function validateSessionDetailSearch(search: Record<string, unknown>): SessionDetailSearch {
	const returnTo = normalizeSessionListReturnTo(search.returnTo);
	const timelineView = parseSessionTimelineView(search.timelineView);
	const matchQuery =
		timelineView === "tools" ? undefined : normalizeSessionMatchQuery(search.matchQuery);
	const standalone = {
		...(matchQuery ? { matchQuery } : {}),
		...(timelineView ? { timelineView } : {}),
		...(returnTo ? { returnTo } : {}),
	};
	if (timelineView === "tools") return standalone;
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
	const matchQuery = view === "tools" ? undefined : normalizeSessionMatchQuery(options.searchQuery);
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
	const matchQuery = timelineView === "tools" ? undefined : normalizeSessionMatchQuery(query);
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
	return normalized.length > 0 && normalized.length <= 500 ? normalized : undefined;
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
	if (timelineView === "tools") {
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
