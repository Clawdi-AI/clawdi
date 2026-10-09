import type { components, paths } from "@clawdi/shared/api";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import createClient from "openapi-fetch";
import { z } from "zod";
import { env } from "@/lib/env";

const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PublicMessagesPage = components["schemas"]["SessionMessagesPage"];

export type PublicShareView = components["schemas"]["PublicSessionShareResponse"];

export type PublicShareResult =
	| { kind: "ok"; share: PublicShareView; messagesPage: PublicMessagesPage }
	| { kind: "expired" }
	| { kind: "not-found" };

/** Read snapshot metadata and the first message page server-side. */
export const getPublicShareData = createServerFn({ method: "GET" })
	.validator(z.object({ shareId: z.string().regex(UUID_RE) }))
	.handler(async ({ data }): Promise<PublicShareResult> => {
		setResponseHeader("cache-control", "no-store");
		const signal = getRequest().signal;

		const api = createClient<paths>({
			baseUrl: env.VITE_CLAWDI_API_URL,
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
				throw new Error("Unable to load shared session messages.");
			}
			return {
				kind: "ok",
				share: frozen.data,
				messagesPage: messages.data,
			};
		}
		if (frozen.response.status === 404) return { kind: "not-found" };
		throw new Error("Unable to load this shared session.");
	});
