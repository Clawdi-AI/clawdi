import type { components } from "@clawdi/shared/api";
import type { QueryClient } from "@tanstack/react-query";
import type { OpenApiClient } from "@/lib/api";

type Agent = components["schemas"]["AgentResponse"];

export const agentsQueryKey = ["get", "/v1/agents", {}] as const;

export function agentDetailQueryKey(agentId: string) {
	return ["get", "/v1/agents/{agent_id}", { params: { path: { agent_id: agentId } } }] as const;
}

/** The list and detail endpoints both return the complete generated AgentResponse projection. */
export function agentDetailInitialDataOptions(queryClient: QueryClient, agentId: string) {
	return {
		initialData: () =>
			queryClient.getQueryData<Agent[]>(agentsQueryKey)?.find((agent) => agent.id === agentId),
		initialDataUpdatedAt: () => queryClient.getQueryState<Agent[]>(agentsQueryKey)?.dataUpdatedAt,
	};
}

export function agentDetailQueryOptions(
	api: OpenApiClient,
	queryClient: QueryClient,
	agentId: string,
) {
	return api.queryOptions(
		"get",
		"/v1/agents/{agent_id}",
		{ params: { path: { agent_id: agentId } } },
		agentDetailInitialDataOptions(queryClient, agentId),
	);
}
