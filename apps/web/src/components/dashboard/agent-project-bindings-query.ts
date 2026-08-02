"use client";

import { useOpenApi } from "@/lib/api";

export function agentProjectBindingsQueryKey(agentId: string | null | undefined) {
	return [
		"get",
		"/v1/agents/{agent_id}/project-bindings",
		{ params: { path: { agent_id: agentId ?? "" } } },
	] as const;
}

export function useAgentProjectBindings(
	agentId: string | null | undefined,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useOpenApi().useQuery(
		"get",
		"/v1/agents/{agent_id}/project-bindings",
		{ params: { path: { agent_id: agentId ?? "" } } },
		{ enabled: enabled && Boolean(agentId) },
	);
}
