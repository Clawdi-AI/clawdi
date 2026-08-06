/**
 * A cloud-api Agent id is a UUID. The post-deploy redirect can briefly land on
 * the Agent route with a deployment id before the Agent id is available, so
 * per-Agent queries must gate on this distinction.
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
