export const HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS = 30_000;
export const HOSTED_AGENT_SESSIONS_REFRESH_POLICY = {
	refetchInterval: HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS,
	refetchIntervalInBackground: false,
} as const;

export function shouldBlockHostedSessionsError(error: unknown, hasData: boolean): boolean {
	return error !== null && error !== undefined && !hasData;
}
