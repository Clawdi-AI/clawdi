import { agentDisconnectEligibility, type AgentOwnership } from "@clawdi/shared/client";

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

export function webAgentDisconnectUnavailable({
	agentId,
	explicitIdentity,
	ownership,
}: {
	agentId: string | null | undefined;
	explicitIdentity?: boolean | null;
	ownership: AgentOwnership | null;
}): boolean {
	return !agentDisconnectEligibility({
		platform: "web",
		agentId,
		explicitIdentity,
		ownership,
	}).eligible;
}
