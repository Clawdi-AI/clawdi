import {
	type DeploymentStatus,
	isTransitionalStatus,
	parseDeploymentStatus,
} from "@clawdi/shared/view";

export {
	type DeploymentStatus,
	type DeploymentStatusPresentation,
	type DeploymentStatusTone,
	deploymentRuntimeStatusPresentation,
	deploymentStatusFromResource,
	deploymentStatusLabel,
	deploymentStatusTone,
	hasCurrentRuntimeHealthDegradation,
	isRunningStatus,
	KNOWN_DEPLOYMENT_STATUSES,
	type KnownDeploymentStatus,
	parseDeploymentStatus,
	type UnknownDeploymentStatus,
} from "@clawdi/shared/view";

import { canCancelDeploymentOperation, deploymentLifecycleAvailable } from "@clawdi/shared/api";
import type { DeploymentOperation } from "@/hosted/billing/contracts";

/**
 * Stopping a deployment removes its cloud-agent projection while preserving
 * the deployment row. Do not query that absent projection until Start moves
 * the deployment back into a recoverable lifecycle state.
 */
export function canQueryDeploymentProjection(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "stopped":
		case "deleted":
			return false;
		case "creating":
		case "starting":
		case "running":
		case "stopping":
		case "restarting":
		case "updating":
		case "failed":
		case "deleting":
			return true;
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "running":
		case "stopped":
		case "failed":
		case "deleted":
			return true;
		case "creating":
		case "starting":
		case "stopping":
		case "restarting":
		case "updating":
		case "deleting":
		case "unknown":
			return false;
		default:
			return exhaustive(status);
	}
}

export function canStart(status: DeploymentStatus): boolean {
	return deploymentLifecycleAvailable("start", status.kind);
}

export function canStop(status: DeploymentStatus): boolean {
	return deploymentLifecycleAvailable("stop", status.kind);
}

export function canRestart(status: DeploymentStatus): boolean {
	return deploymentLifecycleAvailable("restart", status.kind);
}

export function canDelete(status: DeploymentStatus): boolean {
	return deploymentLifecycleAvailable("delete", status.kind);
}

/**
 * Whether the in-flight accepted operation can accept a cancel request. Mirrors
 * the cancel acceptance side in clawdi-hosted operation_cancellation.py: only
 * known operations that are still running and are not backend-managed
 * image or runtime-context migrations are cancellable.
 */
export function canCancelOperation(operation: DeploymentOperation | null | undefined): boolean {
	return canCancelDeploymentOperation(operation);
}

export function shouldPollDeployments(
	items: readonly { status: string | null | undefined }[] | null | undefined,
): boolean {
	return (items ?? []).some((deployment) => {
		const status: DeploymentStatus =
			deployment.status === null || deployment.status === undefined
				? {
						kind: "unknown",
						raw: null,
						known: false,
						reason: "status_unavailable",
					}
				: parseDeploymentStatus(deployment.status);
		return isTransitionalStatus(status);
	});
}

function exhaustive(value: never): never {
	throw new Error(`Unhandled deployment status: ${JSON.stringify(value)}`);
}

export { deploymentTerminalIsAvailable } from "@clawdi/shared/api";
export {
	boundedSettlingPollState,
	currentServingAdvisory,
	DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS,
	DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS,
	DEPLOYMENT_SERVING_ADVISORY_REASONS,
	DEPLOYMENT_TRANSITION_ESCALATION_MS,
	DEPLOYMENT_TRANSITION_TIMEOUT_MS,
	DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
	type DeploymentOperationVerb,
	type DeploymentPollingState,
	type DeploymentServingAdvisoryReason,
	type DeploymentTransitionState,
	deploymentAwaitingRuntimeUi,
	deploymentPollingState,
	deploymentRefetchInterval,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
	isTransitionalStatus,
	type SettlingPollState,
	type SettlingTracker,
} from "@clawdi/shared/view";
