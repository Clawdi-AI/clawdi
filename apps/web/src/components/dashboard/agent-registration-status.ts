import type { components } from "@clawdi/shared/api";
import { daemonStatusVisual } from "@/components/dashboard/daemon-status";

type Env = components["schemas"]["AgentResponse"];

export function agentRegistrationDescription(environments: readonly Env[]): string {
	const hasFreshSyncEvidence =
		environments.length > 0 && environments.every((env) => daemonStatusVisual(env).kind === "live");
	return hasFreshSyncEvidence
		? "Live sync confirmed. New sessions can now appear here automatically."
		: "Registration is complete. Waiting for the first successful sync.";
}
