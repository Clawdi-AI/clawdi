import type { components, paths } from "@clawdi/shared/api";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import createClient from "openapi-fetch";
import { z } from "zod";
import { env } from "@/lib/env";

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PublicShare = components["schemas"]["PublicSessionResponse"];
type PublicMessagesPage = components["schemas"]["SessionMessagesPage"];

export type PublicShareResult =
	| { kind: "ok"; share: PublicShare; messagesPage: PublicMessagesPage }
	| { kind: "unauthorized" }
	| { kind: "forbidden" }
	| { kind: "not-found" };

/**
 * Authentication and both API reads stay inside this server function so
 * Clerk's server runtime and the JWT never enter the client route chunk.
 */
export const getPublicShareData = createServerFn({ method: "GET" })
	.validator(z.object({ sessionId: z.string().regex(UUID_RE) }))
	.handler(async ({ data }): Promise<PublicShareResult> => {
		setResponseHeader("cache-control", "no-store");

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
		const shareResult = await api.GET("/v1/public/sessions/{session_id}", {
			params: { path: { session_id: data.sessionId } },
			cache: "no-store",
		});
		if (shareResult.response.status === 404) return { kind: "not-found" };
		if (shareResult.response.status === 401) return { kind: "unauthorized" };
		if (shareResult.response.status === 403) return { kind: "forbidden" };
		if (shareResult.error !== undefined) {
			throw new Error(`backend returned ${shareResult.response.status}`);
		}

		const messagesResult = await api.GET("/v1/public/sessions/{session_id}/messages", {
			params: {
				path: { session_id: data.sessionId },
				query: { offset: 0, limit: PAGE_SIZE },
			},
			cache: "no-store",
		});
		const messagesPage =
			messagesResult.error === undefined
				? messagesResult.data
				: { items: [], total: 0, offset: 0, limit: PAGE_SIZE };

		return { kind: "ok", share: shareResult.data, messagesPage };
	});
