import {
	type DeploymentStatus,
	deploymentStatusFromResource,
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
import type { DeploymentOperation, HostedDeployment } from "@/hosted/billing/contracts";

// `plan_change` is a projected failure phase; `runtime_switch` remains a live
// legacy wire value while the hosted main rollout converges.
export type DeploymentOperationVerb =
	| DeploymentOperation["metadata"]["verb"]
	| "plan_change"
	| "runtime_switch";

export const DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS = 10_000;
export const DEPLOYMENT_TRANSITION_TIMEOUT_MS = 5 * 60_000;
export const DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS = 10 * 60_000;
// The backend controller keeps recovering stalled generations on its own
// (60s scan, `clawdi_v2_a3_stalled_generation_seconds` in clawdi-hosted
// backend/app/v2/hosted/controller_scheduling.py). Escalation waits well
// past that recovery cadence and past the "taking longer than expected"
// window before offering cancellation, anchored on the same backend-reported
// operation create time.
export const DEPLOYMENT_TRANSITION_ESCALATION_MS = 15 * 60_000;
export const DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS = 60_000;

export type SettlingTracker = {
	key: string;
	startedAtMs: number;
};

export type SettlingPollState = {
	refetchInterval: number | false;
	timedOut: boolean;
	escalated: boolean;
	tracker: SettlingTracker;
};

export type DeploymentTransitionState = {
	kind: "converging" | "timed_out" | "escalated";
	verb: DeploymentOperationVerb | null;
	startedAtMs: number;
};

export type DeploymentPollingState = {
	refetchInterval: number | false;
	trackers: ReadonlyMap<string, SettlingTracker>;
	transitions: ReadonlyMap<string, DeploymentTransitionState>;
};

/**
 * A missing declarative projection is different from an unrecognized future
 * status value. Keep that distinction explicit instead of feeding null through
 * the string parser or fabricating a lifecycle state.
 */

/**
 * Serving advisories are user-resolvable `Degraded=True` reasons the hosted
 * controller projects while the agent keeps running (`Ready` stays True). They
 * never carry a lifecycle failure, so they must not render as failed.
 */
export {
	currentServingAdvisory,
	DEPLOYMENT_SERVING_ADVISORY_REASONS,
	type DeploymentServingAdvisoryReason,
	deploymentRuntimeUiIsReady,
	deploymentRuntimeUiWithdrawn,
} from "@clawdi/shared/view";

import { deploymentRuntimeUiIsReady, deploymentRuntimeUiWithdrawn } from "@clawdi/shared/view";

export { deploymentTerminalIsAvailable } from "@clawdi/shared/api";

/**
 * A running agent whose browser UI has not been admitted yet. A withdrawn
 * dashboard is a settled advisory, not a convergence to poll for.
 */
export function deploymentAwaitingRuntimeUi(deployment: HostedDeployment): boolean {
	const status = deployment.resource.status;
	return (
		deploymentStatusFromResource(status).kind === "running" &&
		!deploymentRuntimeUiWithdrawn(status) &&
		!deploymentRuntimeUiIsReady(deployment)
	);
}

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

export function isTransitionalStatus(status: DeploymentStatus): boolean {
	switch (status.kind) {
		case "creating":
		case "starting":
		case "stopping":
		case "restarting":
		case "updating":
		case "deleting":
		case "unknown":
			return true;
		case "running":
		case "stopped":
		case "failed":
		case "deleted":
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

/** Shared started-at/timeout primitive for lifecycle and runtime-UI convergence. */
export function boundedSettlingPollState({
	key,
	startedAtMs,
	tracker,
	nowMs,
	pollIntervalMs,
	timeoutMs,
	escalationMs = Infinity,
}: {
	key: string;
	startedAtMs: number;
	tracker: SettlingTracker | null;
	nowMs: number;
	pollIntervalMs: number;
	timeoutMs: number;
	escalationMs?: number;
}): SettlingPollState {
	const safeStartedAtMs =
		Number.isFinite(startedAtMs) && startedAtMs <= nowMs ? startedAtMs : nowMs;
	const nextTracker = tracker?.key === key ? tracker : { key, startedAtMs: safeStartedAtMs };
	const ageMs = nowMs - nextTracker.startedAtMs;
	const timedOut = ageMs >= timeoutMs;
	const escalated = timedOut && ageMs >= escalationMs;
	return {
		refetchInterval: timedOut ? false : pollIntervalMs,
		timedOut,
		escalated,
		tracker: nextTracker,
	};
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

/**
 * Fast-poll each accepted lifecycle operation only during its bounded
 * convergence window, then fall back to the foreground reconciliation
 * interval so delayed transitions still surface without a background
 * polling loop.
 */
export function deploymentPollingState(
	deployments: readonly HostedDeployment[] | null | undefined,
	trackers: ReadonlyMap<string, SettlingTracker>,
	nowMs: number,
): DeploymentPollingState {
	const nextTrackers = new Map<string, SettlingTracker>();
	const transitions = new Map<string, DeploymentTransitionState>();
	let refetchInterval: number | false = false;

	for (const deployment of deployments ?? []) {
		if (deployment.accepted_operation?.done && deployment.accepted_operation.error) continue;
		const status = deploymentStatusFromResource(deployment.resource.status);
		const awaitingRuntimeUi = deploymentAwaitingRuntimeUi(deployment);
		if (!isTransitionalStatus(status) && !awaitingRuntimeUi) continue;

		const deploymentId = deployment.resource.id;
		const operation = deployment.accepted_operation;
		const operationStartedAtMs = Date.parse(operation?.metadata.createTime ?? "");
		const pollState = boundedSettlingPollState({
			key: awaitingRuntimeUi
				? `${deploymentTransitionFallbackKey(deployment)}:runtime-ui`
				: (operation?.name ?? deploymentTransitionFallbackKey(deployment)),
			startedAtMs:
				!awaitingRuntimeUi && Number.isFinite(operationStartedAtMs) ? operationStartedAtMs : nowMs,
			tracker: trackers.get(deploymentId) ?? null,
			nowMs,
			pollIntervalMs: DEPLOYMENT_TRANSITIONAL_POLL_INTERVAL_MS,
			timeoutMs:
				!awaitingRuntimeUi && operation?.metadata.verb === "create"
					? DEPLOYMENT_CREATION_TRANSITION_TIMEOUT_MS
					: DEPLOYMENT_TRANSITION_TIMEOUT_MS,
			escalationMs: DEPLOYMENT_TRANSITION_ESCALATION_MS,
		});
		nextTrackers.set(deploymentId, pollState.tracker);
		transitions.set(deploymentId, {
			kind: pollState.escalated ? "escalated" : pollState.timedOut ? "timed_out" : "converging",
			verb: operation?.metadata.verb ?? null,
			startedAtMs: pollState.tracker.startedAtMs,
		});
		if (typeof pollState.refetchInterval === "number") {
			refetchInterval =
				typeof refetchInterval === "number"
					? Math.min(refetchInterval, pollState.refetchInterval)
					: pollState.refetchInterval;
		}
	}
	if (deployments !== null && deployments !== undefined && typeof refetchInterval !== "number") {
		refetchInterval = DEPLOYMENT_RECONCILIATION_POLL_INTERVAL_MS;
	}

	return { refetchInterval, trackers: nextTrackers, transitions };
}

export function deploymentRefetchInterval(
	deployments: readonly HostedDeployment[] | null | undefined,
	trackers: ReadonlyMap<string, SettlingTracker> = new Map(),
	nowMs = Date.now(),
): number | false {
	return deploymentPollingState(deployments, trackers, nowMs).refetchInterval;
}

function deploymentTransitionFallbackKey(deployment: HostedDeployment): string {
	return [
		deployment.resource.id,
		deployment.resource.metadata.generation,
		deployment.resource.spec.desired_lifecycle,
	].join(":");
}

function exhaustive(value: never): never {
	throw new Error(`Unhandled deployment status: ${JSON.stringify(value)}`);
}
