export const HOSTED_AGENT_SESSIONS_REFETCH_INTERVAL_MS = 30_000;

export function shouldBlockHostedSessionsError(error: unknown, hasData: boolean): boolean {
	return error !== null && error !== undefined && !hasData;
}
