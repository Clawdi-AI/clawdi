export const AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS = 3_000;

export function agentChannelLinksQueryBehavior(
	agentId: string,
	{ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {},
) {
	const active = enabled && Boolean(agentId);
	return {
		enabled: active,
		refetchInterval: active && poll ? AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS : false,
		refetchIntervalInBackground: false,
	} as const;
}
