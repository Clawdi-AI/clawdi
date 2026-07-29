export const AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS = 10_000;

/** Foreground polling bridges filesystem projection events until Web SSE owns invalidation. */
export const AGENT_PROJECT_SKILLS_REFRESH_POLICY = {
	refetchInterval: AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS,
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: true,
} as const;

export function agentSkillForegroundRefetchInterval(enabled: boolean): number | false {
	return enabled ? AGENT_PROJECT_SKILLS_REFETCH_INTERVAL_MS : false;
}

export function agentProjectSkillsQueryKey(
	agentId: string,
	projectId: string | null | undefined,
	projectionFence: string,
) {
	return ["skills", "agent-project", agentId, projectId ?? "unavailable", projectionFence] as const;
}

export function agentProjectSkillsQueryEnabled(
	projectId: string | null | undefined,
): projectId is string {
	return Boolean(projectId);
}
