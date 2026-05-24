"use client";

import { extractApiDetail, type paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

const API_URL = env.NEXT_PUBLIC_API_URL;

export class ApiError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(`API ${status}: ${detail}`);
		this.name = "ApiError";
	}
}

/**
 * openapi-fetch client authenticated via Clerk. Response types are inferred
 * from the OpenAPI path + method, so call sites never pass a manual generic.
 *
 * Use inside a React component/hook — Clerk's `getToken` is only available
 * in the browser tree.
 */
export function useApi() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		const client = createClient<paths>({ baseUrl: API_URL });
		client.use({
			async onRequest({ request }) {
				const token = await getToken();
				if (token) request.headers.set("Authorization", `Bearer ${token}`);
				return request;
			},
		});
		return client;
	}, [getToken]);
}

/**
 * Unwrap an openapi-fetch result. Throws ApiError on non-2xx so TanStack
 * Query routes it through its usual error path; returns `data` otherwise.
 *
 * On 2xx-with-no-body (rare: the backend always returns a typed response
 * envelope — even DELETEs return e.g. `{status: "deleted"}`) this returns
 * `undefined` cast to T. Callers that dereference `.foo` on a true 204
 * will runtime-crash, which is fine: that's a contract violation, not a
 * silently-wrong value.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined) {
		throw new ApiError(result.response.status, extractApiDetail(result.error));
	}
	return result.data as T;
}

/**
 * Raw-fetch helper bound to the current Clerk session. Use when the
 * typed openapi-fetch client doesn't yet cover the endpoint (e.g.
 * generated paths are temporarily stale) — the typed `useApi()` client is still the default
 * for everything in the OpenAPI surface.
 *
 * Throws ApiError on non-2xx, mirroring `unwrap()`'s shape so a
 * useQuery / useMutation error path routes through the same channel.
 */
export function useAuthedFetch(): (path: string, init?: RequestInit) => Promise<Response> {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		return async (path: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = await getToken();
			if (token) headers.set("Authorization", `Bearer ${token}`);
			const r = await fetch(`${API_URL}${path}`, { ...init, headers });
			if (!r.ok) throw new ApiError(r.status, await r.text());
			return r;
		};
	}, [getToken]);
}
