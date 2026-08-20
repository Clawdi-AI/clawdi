import type { components } from "@clawdi/shared/api";
import type { QueryClient } from "@tanstack/react-query";

type Agent = components["schemas"]["AgentResponse"];

export const agentsQueryKey = ["get", "/v1/agents", {}] as const;

export function agentDetailQueryKey(agentId: string) {
	return ["get", "/v1/agents/{agent_id}", { params: { path: { agent_id: agentId } } }] as const;
}

/** Keep the exact AgentResponse list projection available to detail consumers. */
export function syncAgentDetailCacheFromList(
	queryClient: QueryClient,
	agents: readonly Agent[],
	listUpdatedAt: number,
): void {
	for (const agent of agents) {
		const queryKey = agentDetailQueryKey(agent.id);
		const detailUpdatedAt = queryClient.getQueryState<Agent>(queryKey)?.dataUpdatedAt ?? 0;
		if (detailUpdatedAt >= listUpdatedAt) continue;
		queryClient.setQueryData<Agent>(queryKey, agent, { updatedAt: listUpdatedAt });
	}
}
