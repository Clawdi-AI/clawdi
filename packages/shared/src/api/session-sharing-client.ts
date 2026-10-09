import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import {
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";
import { buildSessionShareRequest, type SessionShareTarget } from "./session-sharing";

export type SessionSharesQuery = NonNullable<
	paths["/v1/session-shares"]["get"]["parameters"]["query"]
>;
export function createSessionSharingClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		shares: (sessionId: string, signal?: AbortSignal) =>
			transport.read(
				(init) =>
					api.GET("/v1/sessions/{session_id}/shares", {
						...init,
						params: { path: { session_id: readResourceId(sessionId) } },
					}),
				signal,
			),
		deleteSession: (sessionId: string, signal?: AbortSignal) =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/sessions/{session_id}", {
					...init,
					params: { path: { session_id: readResourceId(sessionId) } },
				});
				return { ...result, data: result.response.status === 204 ? null : undefined };
			}, signal),
		list: (query?: SessionSharesQuery, signal?: AbortSignal) =>
			transport.read(
				(init) => api.GET("/v1/session-shares", { ...init, params: { query } }),
				signal,
			),
		create: (sessionId: string, target: SessionShareTarget, signal?: AbortSignal) => {
			const body = buildSessionShareRequest(target);
			return transport.read(
				(init) =>
					api.POST("/v1/sessions/{session_id}/shares", {
						...init,
						params: { path: { session_id: readResourceId(sessionId) } },
						body,
					}),
				signal,
			);
		},
		revoke: (shareId: string, signal?: AbortSignal) =>
			transport.read(async (init) => {
				const result = await api.DELETE("/v1/session-shares/{share_id}", {
					...init,
					params: { path: { share_id: readResourceId(shareId) } },
				});
				return { ...result, data: result.response.status === 204 ? null : undefined };
			}, signal),
		exportMarkdown: (sessionId: string, signal?: AbortSignal) =>
			transport.read(async (init) => {
				const result = await api.GET("/v1/sessions/{session_id}/export.md", {
					...init,
					params: { path: { session_id: readResourceId(sessionId) } },
					parseAs: "text",
				});
				if (
					result.response.ok &&
					!result.response.headers.get("content-type")?.toLowerCase().startsWith("text/markdown")
				)
					throw new ApiClientResponseError();
				return result;
			}, signal),
	};
}
export type SessionSharingClient = ReturnType<typeof createSessionSharingClient>;
