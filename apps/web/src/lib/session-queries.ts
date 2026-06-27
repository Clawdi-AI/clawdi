"use client";

import type { paths } from "@clawdi/shared/api";
import { queryOptions } from "@tanstack/react-query";
import { unwrap, type useApi } from "@/lib/api";

export const SESSION_LIST_STALE_MS = 60_000;
export const SESSION_LIST_GC_MS = 10 * 60_000;
export const SESSION_DETAIL_STALE_MS = 60_000;
export const SESSION_DETAIL_GC_MS = 10 * 60_000;
export const SESSION_MESSAGES_STALE_MS = 5 * 60_000;
export const SESSION_MESSAGES_GC_MS = 30 * 60_000;

type ApiClient = ReturnType<typeof useApi>;
export type SessionListQuery = NonNullable<paths["/api/sessions"]["get"]["parameters"]["query"]>;

const DEFAULT_SESSION_LIST_QUERY = {
	page: 1,
	page_size: 25,
	sort: "last_activity_at",
	order: "desc",
} satisfies SessionListQuery;

function cleanString(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function cleanArray(value: string[] | null | undefined): string[] | undefined {
	if (!value?.length) return undefined;
	const cleaned = value
		.map((item) => item.trim())
		.filter(Boolean)
		.sort();
	return cleaned.length > 0 ? cleaned : undefined;
}

export function normalizeSessionListQuery(query: SessionListQuery = {}): SessionListQuery {
	const normalized: SessionListQuery = {
		page: query.page ?? DEFAULT_SESSION_LIST_QUERY.page,
		page_size: query.page_size ?? DEFAULT_SESSION_LIST_QUERY.page_size,
		sort: cleanString(query.sort) ?? DEFAULT_SESSION_LIST_QUERY.sort,
		order: query.order === "asc" ? "asc" : DEFAULT_SESSION_LIST_QUERY.order,
	};

	const q = cleanString(query.q);
	if (q) normalized.q = q;
	const agent = cleanString(query.agent);
	if (agent) normalized.agent = agent;
	const environmentId = cleanString(query.environment_id);
	if (environmentId) normalized.environment_id = environmentId;
	const model = cleanArray(query.model);
	if (model) normalized.model = model;
	const tag = cleanArray(query.tag);
	if (tag) normalized.tag = tag;
	if (query.min_messages !== null && query.min_messages !== undefined) {
		normalized.min_messages = query.min_messages;
	}
	if (query.min_duration !== null && query.min_duration !== undefined) {
		normalized.min_duration = query.min_duration;
	}
	if (query.has_pr !== null && query.has_pr !== undefined) normalized.has_pr = query.has_pr;
	if (query.automated !== null && query.automated !== undefined) {
		normalized.automated = query.automated;
	}
	const since = cleanString(query.since);
	if (since) normalized.since = since;
	const until = cleanString(query.until);
	if (until) normalized.until = until;

	return normalized;
}

export function sessionListQueryKey(query: SessionListQuery = {}) {
	return ["sessions", "list", normalizeSessionListQuery(query)] as const;
}

export function sessionListQueryOptions(api: ApiClient, query: SessionListQuery = {}) {
	const normalized = normalizeSessionListQuery(query);
	return queryOptions({
		queryKey: sessionListQueryKey(normalized),
		queryFn: async () =>
			unwrap(
				await api.GET("/api/sessions", {
					params: { query: normalized },
				}),
			),
		staleTime: SESSION_LIST_STALE_MS,
		gcTime: SESSION_LIST_GC_MS,
	});
}
