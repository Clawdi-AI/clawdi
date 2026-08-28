import type { SessionListItem } from "@clawdi/shared/api";

export type SessionSearchAnchor = NonNullable<SessionListItem["search_match"]>["anchor"];

export interface SessionDetailSearch {
	matchKind?: SessionSearchAnchor["kind"];
	matchPosition?: number;
	matchRevision?: string;
	returnTo?: string;
}

function validPosition(value: unknown): number | undefined {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function validateSessionDetailSearch(search: Record<string, unknown>): SessionDetailSearch {
	const returnTo = normalizeSessionListReturnTo(search.returnTo);
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
	if (!kind || position === undefined || !revision) return returnTo ? { returnTo } : {};
	return {
		matchKind: kind,
		matchPosition: position,
		matchRevision: revision,
		...(returnTo ? { returnTo } : {}),
	};
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
	options: { returnTo?: string } = {},
) {
	const anchor = session.search_match?.anchor;
	const returnTo = normalizeSessionListReturnTo(options.returnTo);
	return {
		to: "/sessions/$id" as const,
		params: { id: session.id },
		search: {
			...(anchor
				? {
						matchKind: anchor.kind,
						matchPosition: anchor.position,
						matchRevision: anchor.revision,
					}
				: {}),
			...(returnTo ? { returnTo } : {}),
		},
	};
}
