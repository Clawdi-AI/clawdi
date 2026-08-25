import type { OpenApiClient } from "@/lib/api";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";
import { agentPluginIsStalled } from "./agent-plugin-model";

export const AGENT_PLUGIN_DESIRED_QUERY_KEY = [
	"get",
	"/v1/agents/{agent_id}/agent-plugins",
] as const;

const ACTIVE_INSTALL_POLL_MS = 5_000;
const STALLED_INSTALL_POLL_MS = 60_000;

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
			refetchInterval: (query) => {
				const plugins = query.state.data?.plugins;
				if (!plugins?.some((plugin) => plugin.convergence === "not_observed")) return false;
				const now = new Date();
				const interval = plugins.some(
					(plugin) => plugin.convergence === "not_observed" && !agentPluginIsStalled(plugin, now),
				)
					? ACTIVE_INSTALL_POLL_MS
					: STALLED_INSTALL_POLL_MS;
				return eventStreamFallbackInterval(interval, eventStreamActive);
			},
			refetchIntervalInBackground: false,
		},
	);
}
