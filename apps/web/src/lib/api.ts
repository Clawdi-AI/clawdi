"use client";

import { extractApiDetail, type paths } from "@clawdi-cloud/shared/api";
import { useAuth } from "@clerk/nextjs";
import createClient from "openapi-fetch";
import { useMemo } from "react";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

/** Build a full backend URL — for raw fetch (streaming, non-JSON bodies). */
export const apiUrl = (path: string): string => `${API_URL}${path}`;

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
 * 2xx with no body (204 / delete-style responses) surface as `undefined` —
 * call sites that destructure the result already guard with `.items?.` etc.,
 * and the overload set lets `void` responses compile without forcing a cast.
 */
export function unwrap<T>(result: { data: T; error?: undefined; response: Response }): T;
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T;
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined) {
		throw new ApiError(result.response.status, extractApiDetail(result.error));
	}
	return result.data as T;
}
