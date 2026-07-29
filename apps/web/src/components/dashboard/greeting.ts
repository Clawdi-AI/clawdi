export type AgentGreetingState = "loading" | "resolved" | "error";

export function agentGreetingSummary(total: number, state: AgentGreetingState): string {
	if (state === "loading") return "Loading agent status…";
	if (state === "error") return "Agent status is unavailable right now.";
	return total === 0
		? "Connect your first agent to start syncing."
		: `${total} agent${total === 1 ? "" : "s"}`;
}
