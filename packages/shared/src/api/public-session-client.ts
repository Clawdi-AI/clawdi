import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import { createPublicTransport, type PublicApiClientOptions } from "./public-transport";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
} from "./read-transport";

export type PublicSessionView =
	| { source: "snapshot"; detail: components["schemas"]["PublicSessionShareResponse"] }
	| { source: "live"; detail: components["schemas"]["PublicSessionResponse"] };
export function publicSessionId(value: string): string | null {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
		? value.toLowerCase()
		: null;
}
export function publicSessionInput(value: string): string | null {
	const input = value.trim();
	const id = publicSessionId(input);
	if (id) return id;
	try {
		const url = new URL(input);
		if (url.username || url.password || url.search || url.hash) return null;
		const path =
			url.protocol === "clawdi:" && url.hostname === "s"
				? `/s${url.pathname}`
				: url.protocol === "https:"
					? url.pathname
					: "";
		const match = /^\/s\/([^/]+)\/?$/.exec(path);
		return match?.[1] ? publicSessionId(match[1]) : null;
	} catch {
		return null;
	}
}
function requireId(value: string) {
	const id = publicSessionId(value);
	if (!id) throw new ApiClientError(422);
	return id;
}
function validMetadata(value: PublicSessionView["detail"], id: string): boolean {
	return Boolean(
		value &&
			value.id === id &&
			typeof value.started_at === "string" &&
			Number.isSafeInteger(value.message_count) &&
			value.message_count >= 0 &&
			(value.agent_type === null || typeof value.agent_type === "string") &&
			(value.model === null || typeof value.model === "string"),
	);
}

export function createPublicSessionClient(
	options: PublicApiClientOptions & { getToken?: ApiClientOptions["getToken"] },
) {
	const anonymous = createPublicTransport(options);
	const authenticated = options.getToken
		? createReadTransport({
				...options,
				getToken: options.getToken,
				fetch: (request, init) =>
					options.fetch(request, {
						...init,
						credentials: "omit",
						cache: "no-store",
						redirect: "error",
						referrerPolicy: "no-referrer",
					}),
			})
		: null;
	const baseUrl = readApiBaseUrl(options.baseUrl);
	const api = createClient<paths>({ baseUrl, fetch: anonymous.fetch });
	const legacyApi = createClient<paths>({
		baseUrl,
		fetch: authenticated?.fetch ?? anonymous.fetch,
	});
	// Only the legacy/live resource may use an explicitly supplied account token.
	const legacyRead = authenticated?.read ?? anonymous.read;
	return {
		exportJson: async (
			value: string,
			source: PublicSessionView["source"],
			signal?: AbortSignal,
		) => {
			const id = requireId(value);
			const result =
				source === "snapshot"
					? await anonymous.read(
							(init) =>
								api.GET("/v1/public/session-shares/{share_id}/export.json", {
									...init,
									params: { path: { share_id: id } },
								}),
							signal,
						)
					: await legacyRead(
							(init) =>
								legacyApi.GET("/v1/public/sessions/{session_id}/export.json", {
									...init,
									credentials: "omit",
									cache: "no-store",
									redirect: "error",
									params: { path: { session_id: id } },
								}),
							signal,
						);
			if (!result || result.id !== id || !Array.isArray(result.messages))
				throw new ApiClientResponseError();
			return result;
		},
		resolve: async (value: string, signal?: AbortSignal): Promise<PublicSessionView> => {
			const id = requireId(value);
			try {
				const detail = await anonymous.read(
					(init) =>
						api.GET("/v1/public/session-shares/{share_id}", {
							...init,
							params: { path: { share_id: id } },
						}),
					signal,
				);
				if (
					!validMetadata(detail, id) ||
					typeof detail.title !== "string" ||
					!["session", "through", "response"].includes(detail.scope)
				)
					throw new ApiClientResponseError();
				return { source: "snapshot", detail };
			} catch (error) {
				if (!(error instanceof ApiClientError) || error.status !== 404) throw error;
			}
			const detail = await legacyRead(
				(init) =>
					legacyApi.GET("/v1/public/sessions/{session_id}", {
						...init,
						cache: "no-store",
						credentials: "omit",
						redirect: "error",
						params: { path: { session_id: id } },
					}),
				signal,
			);
			if (
				!validMetadata(detail, id) ||
				(detail.summary !== null && typeof detail.summary !== "string")
			)
				throw new ApiClientResponseError();
			return { source: "live", detail };
		},
		messages: async (
			value: string,
			source: PublicSessionView["source"],
			offset: number,
			signal?: AbortSignal,
		) => {
			const id = requireId(value);
			if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiClientError(422);
			const query = { offset, limit: 50 };
			const page =
				source === "snapshot"
					? await anonymous.read(
							(init) =>
								api.GET("/v1/public/session-shares/{share_id}/messages", {
									...init,
									params: { path: { share_id: id }, query },
								}),
							signal,
						)
					: await legacyRead(
							(init) =>
								legacyApi.GET("/v1/public/sessions/{session_id}/messages", {
									...init,
									credentials: "omit",
									cache: "no-store",
									redirect: "error",
									params: { path: { session_id: id }, query: { ...query, direction: "asc" } },
								}),
							signal,
						);
			if (
				!page ||
				!Array.isArray(page.items) ||
				page.offset !== offset ||
				page.limit !== 50 ||
				!Number.isSafeInteger(page.total) ||
				page.total < 0 ||
				page.items.length > 50 ||
				(page.items.length === 0 && offset < page.total) ||
				(offset <= page.total && offset + page.items.length > page.total) ||
				page.items.some(
					(item) =>
						!item || typeof item.content !== "string" || !["user", "assistant"].includes(item.role),
				)
			)
				throw new ApiClientResponseError();
			return page;
		},
		exportMarkdown: async (
			value: string,
			source: PublicSessionView["source"],
			signal?: AbortSignal,
		) => {
			const id = requireId(value);
			const result =
				source === "snapshot"
					? await anonymous.read(async (init) => {
							const result = await api.GET("/v1/public/session-shares/{share_id}/export.md", {
								...init,
								params: { path: { share_id: id } },
								parseAs: "text",
							});
							if (
								result.response.ok &&
								!result.response.headers.get("content-type")?.startsWith("text/markdown")
							)
								throw new ApiClientResponseError();
							return result;
						}, signal)
					: await legacyRead(async (init) => {
							const result = await legacyApi.GET("/v1/public/sessions/{session_id}/export.md", {
								...init,
								credentials: "omit",
								cache: "no-store",
								redirect: "error",
								params: { path: { session_id: id } },
								parseAs: "text",
							});
							if (
								result.response.ok &&
								!result.response.headers.get("content-type")?.startsWith("text/markdown")
							)
								throw new ApiClientResponseError();
							return result;
						}, signal);
			return result;
		},
	};
}
export type PublicSessionClient = ReturnType<typeof createPublicSessionClient>;
