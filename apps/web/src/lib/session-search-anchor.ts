import type { SessionListItem } from "@clawdi/shared/api";

export type SessionSearchAnchor = NonNullable<SessionListItem["search_match"]>["anchor"];

export interface SessionDetailSearch {
	matchKind?: SessionSearchAnchor["kind"];
	matchPosition?: number;
	matchRevision?: string;
}

function validPosition(value: unknown): number | undefined {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function validateSessionDetailSearch(search: Record<string, unknown>): SessionDetailSearch {
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
	if (!kind || position === undefined || !revision) return {};
	return { matchKind: kind, matchPosition: position, matchRevision: revision };
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

export function sessionDetailLink(session: Pick<SessionListItem, "id" | "search_match">) {
	const anchor = session.search_match?.anchor;
	return {
		to: "/sessions/$id" as const,
		params: { id: session.id },
		search: anchor
			? {
					matchKind: anchor.kind,
					matchPosition: anchor.position,
					matchRevision: anchor.revision,
				}
			: {},
	};
}
