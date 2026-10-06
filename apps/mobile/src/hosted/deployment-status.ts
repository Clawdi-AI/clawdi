import type { DeploymentRead } from "@clawdi/shared/api";

export const DEPLOYMENT_POLL_WINDOW_MS = 120_000;

export function operationIdFromName(name: string | undefined): string | null {
	if (!name?.startsWith("operations/")) return null;
	const id = name.slice("operations/".length);
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

type DeploymentPollingState = Pick<DeploymentRead, "accepted_operation"> & {
	resource: Pick<DeploymentRead["resource"], "status">;
};

export function deploymentNeedsPolling(deployment: DeploymentPollingState | undefined): boolean {
	if (!deployment) return false;
	if (deployment.accepted_operation?.done && deployment.accepted_operation.error) return false;
	if (deployment.accepted_operation && !deployment.accepted_operation.done) return true;
	const state = deployment.resource.status?.summary_state;
	return state == null || !["running", "stopped", "deleted", "failed"].includes(state);
}

export function canPollDeployment(
	startedAt: number,
	now: number,
	foreground: boolean,
	online: boolean,
) {
	return foreground && online && now - startedAt < DEPLOYMENT_POLL_WINDOW_MS;
}
