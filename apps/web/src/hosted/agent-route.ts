import type { AgentRouteSearch } from "@/lib/agent-routes";

/**
 * A cloud-api Agent id is a UUID, while Hosted routes use a deployment id.
 * Per-Agent queries must gate on this distinction.
 */
const CLOUD_AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCloudEnvId(value: string): boolean {
	return CLOUD_AGENT_ID_RE.test(value);
}

/** Preserve explicit Cloud intent while allowing UUID-backed Connected Agents. */
export function agentRouteTargetsHostedDeployment(
	agentId: string,
	source: string | null | undefined,
	deploymentSelector: string | null | undefined,
): boolean {
	return source === "on-clawdi" || Boolean(deploymentSelector) || !isCloudEnvId(agentId);
}

/** A deployment id fully identifies a Hosted top-level route. */
export function canonicalHostedAgentSearch(search: AgentRouteSearch): AgentRouteSearch {
	const canonical = { ...search };
	delete canonical.source;
	delete canonical.d;
	return canonical;
}
