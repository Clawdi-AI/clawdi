"use client";

import { normalizeSessionListQuery } from "@clawdi/shared/api";
import type { SessionListQuery } from "@clawdi/shared/view";

export { normalizeSessionListQuery } from "@clawdi/shared/api";

import type { OpenApiClient } from "@/lib/api";

export const SESSION_LIST_STALE_MS = 60_000;
export const SESSION_LIST_GC_MS = 10 * 60_000;
export const SESSION_DETAIL_STALE_MS = 60_000;
export const SESSION_DETAIL_GC_MS = 10 * 60_000;
export const SESSION_MESSAGES_STALE_MS = 5 * 60_000;
export const SESSION_MESSAGES_GC_MS = 30 * 60_000;

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
