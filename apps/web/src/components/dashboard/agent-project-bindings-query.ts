"use client";

import { useQuery } from "@tanstack/react-query";
import type { AgentProjectBinding } from "@/components/dashboard/agent-project-scope";
import { unwrap, useApi } from "@/lib/api";

export function agentProjectBindingsQueryKey(agentId: string | null | undefined) {
	return ["agent-project-bindings", agentId ?? ""] as const;
}

export function useAgentProjectBindings(
	agentId: string | null | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	const api = useApi();
	return useQuery({
		queryKey: agentProjectBindingsQueryKey(agentId),
		queryFn: async (): Promise<AgentProjectBinding[]> => {
			if (!agentId) throw new Error("Agent identity is not resolved");
			return unwrap(
				await api.GET("/v1/agents/{agent_id}/project-bindings", {
					params: { path: { agent_id: agentId } },
				}),
			);
		},
		enabled: enabled && Boolean(agentId),
	});
}
