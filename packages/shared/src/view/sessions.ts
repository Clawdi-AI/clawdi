import type { SessionListItem } from "../api";
import {
	SEARCH_QUERY_MAX_LENGTH,
	SEARCH_QUERY_MIN_LENGTH,
	searchQueryLength,
} from "../consts/search-query";
import { formatSessionSummary, recencyBucketFor } from "./utils";

export function groupSessionsByRecency(
	sessions: SessionListItem[],
	groupBy: "last_activity_at" | "started_at" = "last_activity_at",
) {
	const groups: Array<{ key: string; label: string; items: SessionListItem[] }> = [];
	for (const session of sessions) {
		const bucket = recencyBucketFor(
			groupBy === "started_at" ? session.started_at : session.last_activity_at,
		);
		const last = groups[groups.length - 1];
		if (last && last.key === bucket.key) last.items.push(session);
		else groups.push({ key: bucket.key, label: bucket.label, items: [session] });
	}

	return groups;
}

export function sessionTitle(
	session: Pick<SessionListItem, "summary" | "local_session_id">,
): string {
	return formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
}

export function sessionCardModel(session: SessionListItem, quietAutomated = true) {
	const title = sessionTitle(session);
	const projectFolder = session.project_path?.split("/").pop();
	const totalTokens = session.input_tokens + session.output_tokens;
	const isAutomated = quietAutomated && /^(Cron:|\[)/.test(title);
	return { title, projectFolder, totalTokens, isAutomated };
}

export const SESSION_LIST_COPY = {
	title: "Sessions",
	sharedLinks: "Shared links",
	searchPlaceholder: "Search sessions and messages…",
	agent: "Agent",
	type: "Type",
	prLinks: "PR links",
	hasPr: "Has PR links",
	noPr: "No PR links",
	manual: "Manual",
	automated: "Automated (cron, heartbeat)",
	reset: "Reset",
	rows: "Rows",
	error: "Couldn't load sessions",
	empty: "No sessions yet. Once your agent has a conversation, it'll show up here.",
	filteredEmpty: "No sessions match your filters.",
} as const;

/** Web's inline hint while the typed search is too short or too long to run. */
export function sessionSearchQueryError(query: string): string | null {
	const length = searchQueryLength(query.trim());
	if (length > 0 && length < SEARCH_QUERY_MIN_LENGTH)
		return `Type at least ${SEARCH_QUERY_MIN_LENGTH} characters`;
	if (length > SEARCH_QUERY_MAX_LENGTH) return `Type at most ${SEARCH_QUERY_MAX_LENGTH} characters`;
	return null;
}

export function sessionListEmptyMessage(query: string, filtered: boolean, displayQuery = query) {
	return query
		? `No sessions found for “${displayQuery}”.`
		: filtered
			? SESSION_LIST_COPY.filteredEmpty
			: SESSION_LIST_COPY.empty;
}
