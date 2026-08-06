import { isCloudEnvId } from "@/hosted/agent-route";

export const HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS = 30_000;
export const HOSTED_AGENT_SESSIONS_REFRESH_POLICY = {
	refetchInterval: HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS,
	refetchIntervalInBackground: false,
} as const;

export const HOSTED_AGENT_SESSIONS_EMPTY_MESSAGE = "No sessions from this agent yet.";

/** `/v1/sessions` needs the stable environment identity, not a live runtime projection. */
export function canQueryHostedAgentSessions(environmentId: string): boolean {
	return isCloudEnvId(environmentId);
}
