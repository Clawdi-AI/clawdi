"use client";

import type { paths } from "@clawdi-cloud/shared/api";
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

// FastAPI packs the human message in `detail`; validation errors come back
// as an array of {loc, msg, type}. Flatten into one readable line.
function errorDetail(err: unknown): string {
	if (typeof err === "object" && err !== null && "detail" in err) {
		const d = (err as { detail: unknown }).detail;
		if (typeof d === "string") return d;
		if (Array.isArray(d)) {
			return d
				.map((e) => {
					const loc = Array.isArray((e as { loc?: unknown[] })?.loc)
						? ((e as { loc: unknown[] }).loc as unknown[]).join(".")
						: "";
					const msg = (e as { msg?: string })?.msg ?? "";
					return loc ? `${loc}: ${msg}` : msg;
				})
				.filter(Boolean)
				.join("; ");
		}
	}
	return typeof err === "string" ? err : JSON.stringify(err);
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
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined) {
		throw new ApiError(result.response.status, errorDetail(result.error));
	}
	// 204 No Content etc. — hand back undefined as T for callers that opt in.
	return (result.data as T) ?? (undefined as T);
}
