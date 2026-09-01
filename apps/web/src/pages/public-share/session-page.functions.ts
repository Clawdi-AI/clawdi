import type { components, paths } from "@clawdi/shared/api";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import createClient from "openapi-fetch";
import { z } from "zod";
import { env } from "@/lib/env";

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PublicMessagesPage = components["schemas"]["SessionMessagesPage"];

export type PublicShareView = components["schemas"]["PublicSessionShareResponse"] & {
	source: "share" | "legacy";
};

export type PublicShareResult =
	| { kind: "ok"; share: PublicShareView; messagesPage: PublicMessagesPage }
	| { kind: "unauthorized" }
	| { kind: "forbidden" }
	| { kind: "expired" }
	| { kind: "not-found" };

/** Keep authentication, compatibility fallback, and initial SSR reads server-side. */
export const getPublicShareData = createServerFn({ method: "GET" })
	.validator(z.object({ shareId: z.string().regex(UUID_RE) }))
	.handler(async ({ data }): Promise<PublicShareResult> => {
		setResponseHeader("cache-control", "no-store");
		const signal = getRequest().signal;

		let token: string | null;
		if (env.VITE_DEV_AUTH_BYPASS) {
			token = env.VITE_DEV_AUTH_TOKEN;
		} else {
			const { getToken } = await auth();
			token = await getToken();
		}

		const api = createClient<paths>({
			baseUrl: env.VITE_CLAWDI_API_URL,
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		});
		const frozen = await api.GET("/v1/public/session-shares/{share_id}", {
			params: { path: { share_id: data.shareId } },
			cache: "no-store",
			signal,
		});
		if (frozen.response.status === 410) return { kind: "expired" };
		if (frozen.error === undefined) {
			const messages = await api.GET("/v1/public/session-shares/{share_id}/messages", {
				params: {
					path: { share_id: data.shareId },
					query: { offset: 0, limit: PAGE_SIZE },
				},
				cache: "no-store",
				signal,
			});
			if (messages.response.status === 410) return { kind: "expired" };
			if (messages.error !== undefined) {
				throw new Error(`backend returned ${messages.response.status}`);
			}
			return {
				kind: "ok",
				share: { ...frozen.data, source: "share" },
				messagesPage: messages.data,
			};
		}
		if (frozen.response.status !== 404) {
			throw new Error(`backend returned ${frozen.response.status}`);
		}

		// Compatibility: links created before frozen shares used the Session UUID.
		const legacy = await api.GET("/v1/public/sessions/{session_id}", {
			params: { path: { session_id: data.shareId } },
			cache: "no-store",
			signal,
		});
		if (legacy.response.status === 404) return { kind: "not-found" };
		if (legacy.response.status === 401) return { kind: "unauthorized" };
		if (legacy.response.status === 403) return { kind: "forbidden" };
		if (legacy.error !== undefined) throw new Error(`backend returned ${legacy.response.status}`);

		const messages = await api.GET("/v1/public/sessions/{session_id}/messages", {
			params: {
				path: { session_id: data.shareId },
				query: { offset: 0, limit: PAGE_SIZE, direction: "asc" },
			},
			cache: "no-store",
			signal,
		});
		if (messages.error !== undefined) {
			throw new Error(`backend returned ${messages.response.status}`);
		}
		return {
			kind: "ok",
			share: {
				id: legacy.data.id,
				title: legacy.data.summary || `Shared session ${legacy.data.id.slice(0, 8)}`,
				agent_type: legacy.data.agent_type,
				model: legacy.data.model,
				started_at: legacy.data.started_at,
				created_at: legacy.data.started_at,
				message_count: legacy.data.message_count,
				scope: "session",
				source: "legacy",
			},
			messagesPage: messages.data,
		};
	});
