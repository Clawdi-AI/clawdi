import type { components } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

/** Web's Skills cadence without a deployment event stream; mobile has no event stream. */
const SKILLS_REFETCH_INTERVAL_MS = 10_000;

/**
 * Like Web while its tab is visible, Skills poll whenever the screen is focused, with no time
 * window, so a change accepted on another screen still converges here. TanStack skips interval
 * fetches while the app is in the background and pauses them offline.
 */
export function skillsRefetchPolicy(focused: boolean) {
	return {
		refetchInterval: focused ? SKILLS_REFETCH_INTERVAL_MS : false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	} as const;
}

/** The Agent's Skills inventory, shared by the Skills list and the Library browse sheet. */
export function useAgentDesiredSkills(agentId: string) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { agentExtensions: client } = useMobileApi();
	const focused = useIsFocused();
	return useQuery<components["schemas"]["AgentSkillDesiredListResponse"]>({
		queryKey: accountQueryKey(scope, "agent-desired-skills", agentId),
		enabled: Boolean(agentId && scope.isReady),
		retry: false,
		queryFn: ({ signal }) => read((lease) => client.listSkills(agentId, lease), signal),
		...skillsRefetchPolicy(focused),
	});
}
