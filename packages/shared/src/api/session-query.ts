import type { SessionListQuery } from "./read-clients";

export const SESSION_SORT_KEYS = [
	"last_activity_at",
	"started_at",
	"message_count",
	"tokens",
	"updated_at",
	"relevance",
] as const;

function cleanString(value: string | null | undefined): string | undefined {
	return value?.trim() || undefined;
}

function cleanArray(value: string[] | null | undefined): string[] | undefined {
	const cleaned = value
		?.map((item) => item.trim())
		.filter(Boolean)
		.sort();
	return cleaned?.length ? cleaned : undefined;
}

/** Canonical wire filters shared by native and Web; preserves explicit false/zero. */
export function normalizeSessionListQuery(
	query: SessionListQuery = {},
): NonNullable<SessionListQuery> {
	const normalized: NonNullable<SessionListQuery> = {
		page: query.page ?? 1,
		page_size: query.page_size ?? 25,
		sort: cleanString(query.sort) ?? "last_activity_at",
		order: query.order === "asc" ? "asc" : "desc",
	};
	const q = cleanString(query.q);
	if (q) normalized.q = q;
	const agent = cleanString(query.agent);
	if (agent) normalized.agent = agent;
	const environmentId = cleanString(query.environment_id);
	if (environmentId) normalized.environment_id = environmentId;
	// The default profile's key is "", so only null/undefined means "all profiles".
	if (query.profile_key !== null && query.profile_key !== undefined) {
		normalized.profile_key = query.profile_key;
	}
	const model = cleanArray(query.model);
	if (model) normalized.model = model;
	const tag = cleanArray(query.tag);
	if (tag) normalized.tag = tag;
	if (query.min_messages !== null && query.min_messages !== undefined)
		normalized.min_messages = query.min_messages;
	if (query.min_duration !== null && query.min_duration !== undefined)
		normalized.min_duration = query.min_duration;
	if (query.has_pr !== null && query.has_pr !== undefined) normalized.has_pr = query.has_pr;
	if (query.automated !== null && query.automated !== undefined)
		normalized.automated = query.automated;
	const since = cleanString(query.since);
	if (since) normalized.since = since;
	const until = cleanString(query.until);
	if (until) normalized.until = until;
	return normalized;
}
