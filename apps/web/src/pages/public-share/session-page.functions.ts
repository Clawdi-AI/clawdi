import { ApiClientError, type components, createPublicSessionClient } from "@clawdi/shared/api";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { env } from "@/lib/env";

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

		const client = createPublicSessionClient({
			baseUrl: env.VITE_CLAWDI_API_URL,
			fetch: (request, init) => fetch(request, init),
			...(token ? { getToken: async () => token } : {}),
		});
		try {
			const view = await client.resolve(data.shareId, signal);
			const messagesPage = await client.messages(data.shareId, view.source, 0, signal);
			if (view.source === "snapshot")
				return {
					kind: "ok",
					share: { ...view.detail, source: "share" },
					messagesPage,
				};
			const legacy = view.detail;
			return {
				kind: "ok",
				share: {
					id: legacy.id,
					title: legacy.summary || `Shared session ${legacy.id.slice(0, 8)}`,
					agent_type: legacy.agent_type,
					model: legacy.model,
					started_at: legacy.started_at,
					created_at: legacy.started_at,
					message_count: legacy.message_count,
					scope: "session",
					source: "legacy",
				},
				messagesPage,
			};
		} catch (error) {
			if (error instanceof ApiClientError) {
				if (error.status === 401) return { kind: "unauthorized" };
				if (error.status === 403) return { kind: "forbidden" };
				if (error.status === 404) return { kind: "not-found" };
				if (error.status === 410) return { kind: "expired" };
			}
			throw error;
		}
	});
