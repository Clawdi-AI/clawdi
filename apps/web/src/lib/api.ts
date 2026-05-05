"use client";

import { extractApiDetail, type paths } from "@clawdi/shared/api";
import { useAuth } from "@clerk/nextjs";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { env } from "@/lib/env";

export const API_URL = env.NEXT_PUBLIC_API_URL;

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
	const { getToken } = useAuth();
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
 * Bearer-authenticated fetch wrapper for endpoints not in the OpenAPI schema
 * (currently: the `/api/wiki/*` routes — added on `feat/personal-wiki` before
 * the OpenAPI generator was rerun). Throws ApiError on non-2xx.
 *
 * Prefer `useApi()` + `unwrap()` for any endpoint that IS in the schema —
 * this stays as a fallback so the wiki dashboard builds while the schema
 * regen lands.
 */
export async function apiFetch<T>(path: string, token: string): Promise<T> {
	const res = await fetch(`${API_URL}${path}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	if (!res.ok) {
		let detail = "";
		try {
			const body = await res.json();
			detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
		} catch {
			detail = await res.text();
		}
		throw new ApiError(res.status, detail);
	}
	return (await res.json()) as T;
}
