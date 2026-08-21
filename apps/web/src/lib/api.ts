"use client";

import { type components, extractApiDetail, type paths } from "@clawdi/shared/api";
import createClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { useCallback, useMemo } from "react";
import { observeAccountSuspensionResponse } from "@/lib/account-suspension";
import { ApiError, ApiNetworkError, apiErrorCode } from "@/lib/api-errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

// `ApiError` and the cloud-api error-toast helper live in `api-errors` (a
// dependency-free module so they're unit-testable); re-export so the many
// existing `@/lib/api` import sites keep working.
export { ApiError, toastApiError } from "@/lib/api-errors";

const API_URL = env.VITE_CLAWDI_API_URL;
type SkillUploadResponse = components["schemas"]["SkillUploadResponse"];
type EnvironmentResponse = components["schemas"]["AgentResponse"];

type ApiErrorResponse<Response> = Response extends object
	? Omit<Response, "content"> & { content: { "application/json": ApiError } }
	: Response;
type ApiResponses<Responses> = {
	[Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
		? Responses[Status]
		: ApiErrorResponse<Responses[Status]>;
} & { default: { content: { "application/json": ApiError } } };
type ApiOperation<Operation> = Operation extends { responses: infer Responses }
	? Omit<Operation, "responses"> & { responses: ApiResponses<Responses> }
	: Operation;
type ApiPaths = {
	[Path in keyof paths]: { [Method in keyof paths[Path]]: ApiOperation<paths[Path][Method]> };
};

function apiUrl(path: string): string {
	const base = API_URL.endsWith("/") ? API_URL : `${API_URL}/`;
	return new URL(path.replace(/^\/+/, ""), base).toString();
}

/**
 * Client-side request ceiling. A hung backend or a black-holed connection must
 * not leave a surface spinning forever — abort after this and surface a
 * recoverable `ApiNetworkError("timeout")` instead. Matches the hosted billing
 * client's 20s bound.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` wrapper that bounds every request with a timeout and maps transport
 * failures to a normalizable `ApiNetworkError`. A caller-supplied abort is
 * preserved and re-thrown as-is so an intentional cancel isn't mislabeled as a
 * network failure.
 */
function fetchWithTimeout(request: Request, init?: RequestInit): Promise<Response> {
	const caller = init?.signal ?? request.signal;
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (caller?.aborted) {
		controller.abort();
	} else {
		caller?.addEventListener("abort", onAbort, { once: true });
	}
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	return fetch(request, { ...init, signal: controller.signal })
		.then(async (response) => {
			await observeAccountSuspensionResponse(response);
			return response;
		})
		.catch((cause: unknown) => {
			if (timedOut) throw new ApiNetworkError("timeout", { cause });
			if (caller?.aborted) throw cause;
			throw new ApiNetworkError("offline", { cause });
		})
		.finally(() => {
			clearTimeout(timeoutId);
			caller?.removeEventListener("abort", onAbort);
		});
}

/**
 * openapi-fetch client authenticated via Clerk. Response types are inferred
 * from the OpenAPI path + method, so call sites never pass a manual generic.
 *
 * Use inside a React component/hook — Clerk's `getToken` is only available
 * in the browser tree.
 */
function useConfiguredApi(throwOnError: boolean) {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		const client = createClient<ApiPaths>({ baseUrl: API_URL, fetch: fetchWithTimeout });
		client.use({
			async onRequest({ request }) {
				const token = await getToken();
				if (token) request.headers.set("Authorization", `Bearer ${token}`);
				return request;
			},
		});
		if (throwOnError) {
			client.use({
				async onResponse({ response }) {
					if (!response.ok) {
						throw await apiErrorFromResponse(response.clone());
					}
					return response;
				},
			});
		}
		return client;
	}, [getToken, throwOnError]);
}

/** Generated fetch client for flows that inspect the typed response envelope directly. */
export function useApi() {
	return useConfiguredApi(false);
}

/** Standard OpenAPI-backed TanStack Query client with shared transport policy. */
export function useOpenApi() {
	const client = useConfiguredApi(true);
	return useMemo(() => createQueryClient(client), [client]);
}
export type OpenApiClient = ReturnType<typeof useOpenApi>;

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
		throw new ApiError(
			result.response.status,
			extractApiDetail(result.error),
			apiErrorCode(result.error),
		);
	}
	return result.data as T;
}

export function ensureBlob(value: unknown): Blob {
	if (value instanceof Blob) return value;
	throw new Error("Expected a binary API response");
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
	try {
		if ((response.headers.get("content-type") ?? "").includes("application/json")) {
			const body: unknown = await response.json();
			return new ApiError(response.status, extractApiDetail(body), apiErrorCode(body));
		}
		if ((response.headers.get("content-type") ?? "").includes("+json")) {
			const body: unknown = await response.json();
			return new ApiError(response.status, extractApiDetail(body), apiErrorCode(body));
		}
		return new ApiError(response.status, (await response.text()) || response.statusText);
	} catch {
		return new ApiError(response.status, response.statusText);
	}
}

async function readJson<T>(response: Response): Promise<T> {
	const body: unknown = await response.json();
	return body as T;
}

export function useSkillArchiveUploader() {
	const { getToken } = useAuthToken();
	return useCallback(
		async (
			projectId: string,
			skillKey: string,
			archive: Blob,
			options?: { createOnly?: boolean },
		): Promise<SkillUploadResponse> => {
			const fileName = `${skillKey.replace(/\//g, "-")}.tar.gz`;
			const form = new FormData();
			form.append("skill_key", skillKey);
			form.append("file", archive, fileName);
			if (options?.createOnly) form.append("create_only", "true");

			const headers = new Headers();
			const token = await getToken();
			if (token) headers.set("Authorization", `Bearer ${token}`);

			const response = await fetchWithTimeout(
				new Request(apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/skills/upload`), {
					method: "POST",
					headers,
					body: form,
				}),
			);
			if (!response.ok) {
				throw await apiErrorFromResponse(response);
			}
			return readJson<SkillUploadResponse>(response);
		},
		[getToken],
	);
}

export function useAgentAvatarUploader() {
	const { getToken } = useAuthToken();
	return useCallback(
		async (environmentId: string, file: File): Promise<EnvironmentResponse> => {
			const form = new FormData();
			form.append("file", file, file.name || "agent-avatar");

			const headers = new Headers();
			const token = await getToken();
			if (token) headers.set("Authorization", `Bearer ${token}`);

			const response = await fetchWithTimeout(
				new Request(apiUrl(`/v1/agents/${encodeURIComponent(environmentId)}/avatar`), {
					method: "POST",
					headers,
					body: form,
				}),
			);
			if (!response.ok) throw await apiErrorFromResponse(response);
			return readJson<EnvironmentResponse>(response);
		},
		[getToken],
	);
}
