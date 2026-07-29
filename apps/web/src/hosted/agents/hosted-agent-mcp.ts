import type { components } from "@clawdi/shared/api";
import { runtimeEvidenceMatchesDeployment } from "@/hooks/agent-runtime-observed-query";
import { isCloudEnvId } from "@/hosted/agent-identity";

export type AgentMcpInventory = components["schemas"]["AgentMcpInventoryResponse"];
type AgentRuntimeObserved = components["schemas"]["AgentRuntimeObservedResponse"];
type RuntimeObservedHealth = components["schemas"]["RuntimeObservedHealthResponse"];

const MCP_INVENTORY_REFRESH_MS = 10_000;
const MCP_INVENTORY_UNAVAILABLE_REFRESH_MS = 2_000;

/**
 * The Hosted resource version fences cached desired inventory across canonical
 * deployment snapshots. It is cache identity only; runtime health remains the
 * sole convergence signal.
 */
export function agentMcpInventoryQueryKey(agentId: string, deploymentResourceVersion: string) {
	return ["agent-mcp", agentId, deploymentResourceVersion] as const;
}

export function agentMcpInventoryQueryEnabled(agentId: string): boolean {
	return isCloudEnvId(agentId);
}

export function agentMcpInventoryMatchesDeployment(
	inventory: AgentMcpInventory | undefined,
	deploymentId: string,
): boolean {
	return (
		inventory?.availability === "available" &&
		runtimeEvidenceMatchesDeployment(deploymentId, inventory.deployment_id)
	);
}

/** Never attach convergence evidence from the deployment that was replaced. */
export function mcpRuntimeHealthForDeployment(
	runtime: AgentRuntimeObserved | undefined,
	deploymentId: string,
): RuntimeObservedHealth | undefined {
	return runtimeEvidenceMatchesDeployment(deploymentId, runtime?.desired?.deployment_id)
		? runtime?.health
		: undefined;
}

/** Settle polling only when the canonical overall health belongs to this deployment. */
export function mcpRuntimeIsConvergedForDeployment(
	runtime: AgentRuntimeObserved,
	deploymentId: string,
): boolean {
	return mcpRuntimeHealthForDeployment(runtime, deploymentId)?.status === "ok";
}

/** Keep an active MCP page fresh while downstream desired state is projected. */
export function agentMcpInventoryRefetchInterval(
	inventory: AgentMcpInventory | undefined,
	deploymentId: string,
): number {
	return agentMcpInventoryMatchesDeployment(inventory, deploymentId)
		? MCP_INVENTORY_REFRESH_MS
		: MCP_INVENTORY_UNAVAILABLE_REFRESH_MS;
}
