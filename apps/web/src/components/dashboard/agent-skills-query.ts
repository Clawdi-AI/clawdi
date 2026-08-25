import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

export const AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS = 10_000;

/** Foreground polling bridges filesystem projection events until Web SSE owns invalidation. */
export const AGENT_PROJECT_SKILLS_REFRESH_POLICY = {
	refetchInterval: AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS,
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: true,
} as const;

export function agentSkillForegroundRefetchInterval(
	enabled: boolean,
	eventStreamActive = false,
): number | false {
	return enabled
		? eventStreamFallbackInterval(AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS, eventStreamActive)
		: false;
}

export function agentProjectSkillsQueryKey(
	agentId: string,
	projectIds: readonly string[],
	projectionFence: string,
) {
	return ["skills", "agent-projects", agentId, projectionFence, ...projectIds] as const;
}

export function agentProjectSkillsQueryEnabled(
	bindingsResolved: boolean,
	projectIds: readonly string[],
): boolean {
	return bindingsResolved && projectIds.length > 0;
}
