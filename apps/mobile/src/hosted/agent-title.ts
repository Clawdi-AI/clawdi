import type { DeploymentRead } from "@clawdi/shared/api";
import { type AgentIdentityInput, agentDisplayName } from "@clawdi/shared/view";

/** Like Web, the Agent's own name wins so a rename shows at once; the deployment's default
 * name is only a fallback while the Agent loads. */
export function hostedAgentTitle(
	agent: AgentIdentityInput | undefined,
	deployment: Pick<DeploymentRead, "resource"> | undefined,
): string | null {
	if (agent) return agentDisplayName(agent);
	if (!deployment) return null;
	return agentDisplayName({
		default_name: deployment.resource.name,
		agent_type: deployment.resource.spec.runtime,
	});
}
