import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

export const AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS = 3_000;

export function agentChannelLinksQueryBehavior(
	agentId: string,
	{
		enabled = true,
		poll = false,
		eventStreamActive = false,
	}: { enabled?: boolean; poll?: boolean; eventStreamActive?: boolean } = {},
) {
	const active = enabled && Boolean(agentId);
	return {
		enabled: active,
		refetchInterval:
			active && poll
				? eventStreamFallbackInterval(AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS, eventStreamActive)
				: false,
		refetchIntervalInBackground: false,
	} as const;
}
