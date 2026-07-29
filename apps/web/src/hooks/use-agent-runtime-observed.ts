import { useQuery } from "@tanstack/react-query";
import {
	agentRuntimeObservedQueryKey,
	agentRuntimeObservedRefetchInterval,
	runtimeHealthIsConverged,
} from "@/hooks/agent-runtime-observed-query";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";

type RuntimeObserved = components["schemas"]["AgentRuntimeObservedResponse"];

export function useAgentRuntimeObserved(
	agentId: string,
	enabled = true,
	cacheFence?: string,
	isConverged: (snapshot: RuntimeObserved) => boolean = runtimeHealthIsConverged,
) {
	const api = useApi();
	return useQuery({
		queryKey: agentRuntimeObservedQueryKey(agentId, cacheFence, enabled),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/agents/{agent_id}/runtime-observed", {
					params: { path: { agent_id: agentId } },
				}),
			),
		enabled,
		refetchInterval: (query) => agentRuntimeObservedRefetchInterval(query.state.data, isConverged),
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
	});
}
