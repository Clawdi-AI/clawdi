/**
 * Shared identity/naming helpers for hosted deployments and their cloud-api
 * agent environments. Centralized so the agent detail view, the agent-home
 * router, and the dashboard tile projection don't each carry their own copy.
 */

/**
 * A cloud-api environment id is a UUID. Hosted target routes may use a
 * `deploymentId:agentId` id before env ids are minted, so per-env queries
 * must gate on this to avoid firing a 422 against `/api/sessions`.
 */
const CLOUD_ENV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` looks like a real cloud-api env id (UUID), not a deployment id. */
export function isCloudEnvId(value: string): boolean {
	return CLOUD_ENV_ID_RE.test(value);
}

export function hostedRuntimeTargetRouteId(deploymentId: string, agentId: string): string {
	return `${deploymentId}:${agentId}`;
}

export function parseHostedRuntimeTargetRouteId(
	value: string,
): { deploymentId: string; agentId: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return null;
	const deploymentId = value.slice(0, separator);
	const agentId = value.slice(separator + 1);
	return { deploymentId, agentId };
}

/**
 * Keep user-given deployment names intact while preserving the existing
 * runtime-prefix cleanup for generated runtime labels.
 */
export function deploymentDisplayName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "Clawdi Cloud agent";
	return trimmed.replace(/^(codex|openclaw|hermes)-/i, "") || trimmed;
}
