"use client";

import { normalizeSessionListQuery, type paths } from "@clawdi/shared/api";

export { normalizeSessionListQuery } from "@clawdi/shared/api";

import type { OpenApiClient } from "@/lib/api";

export const SESSION_LIST_STALE_MS = 60_000;
export const SESSION_LIST_GC_MS = 10 * 60_000;
export const SESSION_DETAIL_STALE_MS = 60_000;
export const SESSION_DETAIL_GC_MS = 10 * 60_000;
export const SESSION_MESSAGES_STALE_MS = 5 * 60_000;
export const SESSION_MESSAGES_GC_MS = 30 * 60_000;

export type SessionListQuery = NonNullable<paths["/v1/sessions"]["get"]["parameters"]["query"]>;

export function sessionListQueryKey(query: SessionListQuery = {}) {
	return ["get", "/v1/sessions", { params: { query: normalizeSessionListQuery(query) } }] as const;
}

export function sessionDetailQueryKey(sessionId: string) {
	return [
		"get",
		"/v1/sessions/{session_id}",
		{ params: { path: { session_id: sessionId } } },
	] as const;
}

export function sessionListQueryOptions(api: OpenApiClient, query: SessionListQuery = {}) {
	const normalized = normalizeSessionListQuery(query);
	return api.queryOptions(
		"get",
		"/v1/sessions",
		{ params: { query: normalized } },
		{
			staleTime: SESSION_LIST_STALE_MS,
			gcTime: SESSION_LIST_GC_MS,
		},
	);
}
