import { agentPluginRefetchInterval } from "@clawdi/shared/api";
import type { OpenApiClient } from "@/lib/api";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

export const AGENT_PLUGIN_DESIRED_QUERY_KEY = [
	"get",
	"/v1/agents/{agent_id}/agent-plugins",
] as const;

export function agentPluginDesiredStateQueryOptions(
	api: OpenApiClient,
	agentId: string,
	eventStreamActive = false,
) {
	return api.queryOptions(
		"get",
		"/v1/agents/{agent_id}/agent-plugins",
		{ params: { path: { agent_id: agentId } } },
		{
			refetchInterval: (query) =>
				eventStreamFallbackInterval(
					agentPluginRefetchInterval(query.state.data?.plugins, new Date()),
					eventStreamActive,
				),
			refetchIntervalInBackground: false,
		},
	);
}
