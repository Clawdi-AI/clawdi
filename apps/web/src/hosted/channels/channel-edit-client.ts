"use client";

import { extractApiDetail } from "@clawdi/shared/api";
import { useMemo } from "react";
import { ApiError, ApiNetworkError } from "@/lib/api-errors";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";

const API_URL = env.NEXT_PUBLIC_API_URL;

/** Client-side request ceiling so a stalled call can't freeze the page (matches lib/api.ts). */
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (cause) {
		if (timedOut) throw new ApiNetworkError("timeout", { cause });
		throw new ApiNetworkError("offline", { cause });
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Account summary embedded in an agent's channel link. Handwritten to mirror
 * the cloud-api `/api/channels/agent-links` response.
 */
export interface AgentChannelLinkAccount {
	id: string;
	provider: string;
	name: string;
	status: string;
	visibility: "private" | "public";
}

/** An agent's channel link with its embedded account summary. */
export interface AgentChannelLink {
	id: string;
	account_id: string;
	agent_id: string;
	status: string;
	created_at: string;
	agent_token?: string | null;
	/**
	 * Embedded account summary. OPTIONAL on purpose: the cloud-api list-by-agent
	 * response (#155) is not guaranteed to nest the account — the matching
	 * backend link schema (`ChannelAgentLinkResponse`) carries only
	 * `account_id`. Consumers MUST null-guard and fall back to `account_id` /
	 * the loaded channels list (apps/web has no ErrorBoundary).
	 */
	account?: AgentChannelLinkAccount | null;
}

/**
 * Handwritten, Clerk-authenticated client for the two agent-link edit routes.
 *
 * These endpoints ship in the cloud-api PR and are intentionally NOT part of
 * main's generated OpenAPI client, so we call them directly with the Clerk
 * bearer instead of `useApi`. Non-2xx responses throw `ApiError` so the
 * channel hooks route failures through their existing error handling.
 */
export function useChannelEditApi() {
	const { getToken } = useAuthToken();
	return useMemo(() => {
		async function request<T>(
			path: string,
			init: { method: "GET" | "DELETE"; query?: Record<string, string> },
		): Promise<T> {
			const token = await getToken();
			const url = new URL(`${API_URL}${path}`);
			if (init.query) {
				for (const [key, value] of Object.entries(init.query)) url.searchParams.set(key, value);
			}
			let response: Response;
			response = await fetchWithTimeout(url.toString(), {
				method: init.method,
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			});
			if (!response.ok) {
				let detail = response.statusText;
				try {
					detail = extractApiDetail(await response.json());
				} catch {
					// Non-JSON error body — fall back to the status text.
				}
				throw new ApiError(response.status, detail);
			}
			if (response.status === 204) return undefined as T;
			const text = await response.text();
			return (text ? JSON.parse(text) : undefined) as T;
		}

		return {
			/** GET /api/channels/agent-links?agent_id={id} — links for one agent. */
			listAgentLinks: (agentId: string) =>
				request<AgentChannelLink[]>("/api/channels/agent-links", {
					method: "GET",
					query: { agent_id: agentId },
				}),
			/** DELETE /api/channels/{accountId}/agent-links/{linkId} — unlink. */
			unlinkAgent: (accountId: string, linkId: string) =>
				request<void>(
					`/api/channels/${encodeURIComponent(accountId)}/agent-links/${encodeURIComponent(linkId)}`,
					{ method: "DELETE" },
				),
		};
	}, [getToken]);
}
