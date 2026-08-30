export function syncAgentNameDraft(
	currentDraft: string,
	previousServerName: string | undefined,
	nextServerName: string,
): string {
	if (previousServerName === undefined || currentDraft === previousServerName) {
		return nextServerName;
	}
	return currentDraft;
}
