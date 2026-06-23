"use client";

import type { components } from "@clawdi/shared/api";
import { useMemo } from "react";
import { unwrap, useApi } from "@/lib/api";

type GeneratedAgentChannelLink = components["schemas"]["ChannelAgentLinkWithAccountResponse"];

export type AgentChannelLink = Omit<GeneratedAgentChannelLink, "account"> & {
	account?: components["schemas"]["ChannelAccountResponse"] | null;
};

/**
 * Small facade over the generated cloud-api client for agent-link edit routes.
 * Keeping the two methods together lets the channel hooks stay focused on
 * query invalidation while request/response types still come from OpenAPI.
 */
export function useChannelEditApi() {
	const api = useApi();
	return useMemo(() => {
		return {
			/** GET /api/channels/agent-links?agent_id={id} — links for one agent. */
			listAgentLinks: async (agentId: string) =>
				unwrap(
					await api.GET("/api/channels/agent-links", {
						params: { query: { agent_id: agentId } },
					}),
				),
			/** DELETE /api/channels/{accountId}/agent-links/{linkId} — unlink. */
			unlinkAgent: async (accountId: string, linkId: string) =>
				unwrap(
					await api.DELETE("/api/channels/{account_id}/agent-links/{link_id}", {
						params: { path: { account_id: accountId, link_id: linkId } },
					}),
				),
		};
	}, [api]);
}
